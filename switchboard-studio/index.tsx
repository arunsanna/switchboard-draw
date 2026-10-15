import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Excalidraw,
  MainMenu,
  WelcomeScreen,
  getSceneVersion,
  serializeAsJSON,
} from "@excalidraw/excalidraw";

import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";


type Theme = "light" | "dark";

type OpenRequest = {
  /** A `.excalidraw` document, as text or already parsed; empty for a new diagram. */
  scene?: string | Record<string, unknown> | null;
  theme?: Theme;
};

type StudioMessage =
  | { type: "ready" }
  | { type: "changed" }
  | { type: "save"; scene: string };

declare global {
  interface Window {
    webkit?: { messageHandlers?: { studio?: { postMessage: (message: StudioMessage) => void } } };
    switchboardStudio?: {
      open: (request: OpenRequest) => void;
      setTheme: (theme: Theme) => void;
      getScene: () => string | null;
    };
  }
}

const SAVE_DELAY_MS = 800;
const params = new URLSearchParams(window.location.search);
const diagramID = params.get("diagram");
const nativeBridge = window.webkit?.messageHandlers?.studio;

/** In the Switchboard app the native side loads and saves; in a browser the gateway does. */
const host = {
  ready() {
    nativeBridge?.postMessage({ type: "ready" });
  },
  changed() {
    nativeBridge?.postMessage({ type: "changed" });
  },
  async save(scene: string) {
    if (nativeBridge) {
      nativeBridge.postMessage({ type: "save", scene });
    } else if (diagramID) {
      await fetch(`../api/diagrams/${encodeURIComponent(diagramID)}/scene`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: scene,
      });
    }
  },
  async load(): Promise<OpenRequest | null> {
    if (nativeBridge) {
      return null;
    }
    if (!diagramID) {
      return { scene: null }; // a scratch board when opened without a diagram
    }
    const response = await fetch(`../api/diagrams/${encodeURIComponent(diagramID)}/scene`);
    if (response.status === 404) {
      return { scene: null };
    }
    return { scene: await response.text() };
  },
};

function initialDataFrom(request: OpenRequest): ExcalidrawInitialDataState {
  const raw = request.scene;
  if (!raw) {
    return { elements: [], appState: {} };
  }
  const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
    elements?: ExcalidrawElement[];
    appState?: Partial<AppState>;
    files?: BinaryFiles;
  };
  return {
    elements: parsed.elements ?? [],
    appState: parsed.appState ?? {},
    files: parsed.files ?? {},
    scrollToContent: true,
  };
}

const Studio = ({ request, theme }: { request: OpenRequest; theme: Theme }) => {
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const lastSaved = useRef<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const [initialData] = useState(() => initialDataFrom(request));

  useEffect(() => {
    window.switchboardStudio!.getScene = () => {
      const current = api.current;
      if (!current) {
        return null;
      }
      return serializeAsJSON(current.getSceneElementsIncludingDeleted(), current.getAppState(), current.getFiles(), "local");
    };
  }, []);

  const onChange = (elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
    const key = `${getSceneVersion(elements)}|${appState.viewBackgroundColor}|${Object.keys(files).length}`;
    if (lastSaved.current === null) {
      lastSaved.current = key; // the scene as opened is already saved
      return;
    }
    if (key === lastSaved.current) {
      return;
    }
    lastSaved.current = key;
    host.changed();
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void host.save(serializeAsJSON(elements, appState, files, "local"));
    }, SAVE_DELAY_MS);
  };

  return (
    <Excalidraw
      initialData={initialData}
      excalidrawAPI={(instance) => (api.current = instance)}
      onChange={onChange}
      theme={theme}
      UIOptions={{
        canvasActions: {
          loadScene: false,
          saveToActiveFile: false,
          toggleTheme: null,
          export: { saveFileToDisk: true },
        },
      }}
    >
      <MainMenu>
        <MainMenu.DefaultItems.SaveAsImage />
        <MainMenu.DefaultItems.Export />
        <MainMenu.DefaultItems.ClearCanvas />
        <MainMenu.Separator />
        <MainMenu.DefaultItems.ChangeCanvasBackground />
        <MainMenu.Separator />
        <MainMenu.DefaultItems.Help />
      </MainMenu>
      <WelcomeScreen>
        <WelcomeScreen.Center>
          <WelcomeScreen.Center.Heading>Draw anything. It saves on its own.</WelcomeScreen.Center.Heading>
        </WelcomeScreen.Center>
        <WelcomeScreen.Hints.ToolbarHint />
        <WelcomeScreen.Hints.MenuHint />
        <WelcomeScreen.Hints.HelpHint />
      </WelcomeScreen>
    </Excalidraw>
  );
};

const root = createRoot(document.getElementById("root")!);
let theme: Theme = params.get("theme") === "dark" ? "dark" : "light";
let current: OpenRequest | null = null;

function render() {
  if (!current) {
    return;
  }
  root.render(
    <StrictMode>
      <Studio key={String(current.scene ? "loaded" : "new")} request={current} theme={theme} />
    </StrictMode>,
  );
}

window.switchboardStudio = {
  open(request) {
    current = request;
    theme = request.theme ?? theme;
    render();
  },
  setTheme(next) {
    theme = next;
    render();
  },
  getScene: () => null,
};

void host.load().then((request) => {
  if (request) {
    window.switchboardStudio!.open(request);
  }
  host.ready();
});
