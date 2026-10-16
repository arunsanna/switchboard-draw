import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw, MainMenu, WelcomeScreen } from "@excalidraw/excalidraw";

import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

import {
  DiagramSync,
  gatewayTransport,
  legacyNativeTransport,
  listenToGateway,
  nativeBridge,
  nativeBridgeAnswers,
  nativeTransport,
  scratchTransport,
  serializeScene,
} from "./sync";

import type { LoadedScene, Transport } from "./sync";

type Theme = "light" | "dark";

/** Switchboard Mac 2.0.6 (330) and older open the scene with this call. */
type LegacyOpenRequest = {
  scene?: string | Record<string, unknown> | null;
  theme?: Theme;
};

declare global {
  interface Window {
    switchboardStudio?: {
      /** Another copy saved this version; pull it if it is newer. */
      remoteChanged: (version: number) => void;
      /** Pull the newest version, e.g. after reconnecting. */
      refresh: () => void;
      setTheme: (theme: Theme) => void;
      /** The scene as it would be saved, or null before it opens. */
      getScene: () => string | null;
      /** The gateway version the page's scene includes. */
      getVersion: () => number;
      open: (request: LegacyOpenRequest) => void;
    };
  }
}

const RETRY_DELAY_MS = 5000;
const params = new URLSearchParams(window.location.search);
const diagramID = params.get("diagram");

let legacyOpen: ((scene: string | null) => void) | null = null;

function makeTransport(): Transport {
  const bridge = nativeBridge();
  if (bridge) {
    return nativeBridgeAnswers(bridge)
      ? nativeTransport(bridge)
      : legacyNativeTransport(bridge, (open) => (legacyOpen = open));
  }
  return diagramID ? gatewayTransport(diagramID) : scratchTransport;
}

function initialDataFrom(scene: string | null): ExcalidrawInitialDataState {
  if (!scene) {
    return { elements: [], appState: {} };
  }
  const parsed = JSON.parse(scene) as {
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

const Studio = ({
  loaded,
  sync,
  theme,
}: {
  loaded: LoadedScene;
  sync: DiagramSync;
  theme: Theme;
}) => {
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const [initialData] = useState(() => initialDataFrom(loaded.scene));

  useEffect(() => {
    window.switchboardStudio!.getScene = () =>
      api.current ? serializeScene(api.current) : null;
  }, []);

  return (
    <Excalidraw
      initialData={initialData}
      excalidrawAPI={(instance) => {
        api.current = instance;
        sync.attach(instance);
      }}
      onChange={(elements, appState, files) =>
        sync.onChange(elements, appState, files)
      }
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
          <WelcomeScreen.Center.Heading>
            Draw anything. It saves on its own.
          </WelcomeScreen.Center.Heading>
        </WelcomeScreen.Center>
        <WelcomeScreen.Hints.ToolbarHint />
        <WelcomeScreen.Hints.MenuHint />
        <WelcomeScreen.Hints.HelpHint />
      </WelcomeScreen>
    </Excalidraw>
  );
};

const root = createRoot(document.getElementById("root")!);
const transport = makeTransport();
let theme: Theme = params.get("theme") === "dark" ? "dark" : "light";
let opened: { loaded: LoadedScene; sync: DiagramSync } | null = null;

function render() {
  if (!opened) {
    return;
  }
  root.render(
    <StrictMode>
      <Studio loaded={opened.loaded} sync={opened.sync} theme={theme} />
    </StrictMode>,
  );
}

window.switchboardStudio = {
  remoteChanged: (version) => opened?.sync.remoteChanged(version),
  refresh: () => opened?.sync.refresh(),
  setTheme(next) {
    theme = next;
    render();
  },
  getScene: () => null,
  getVersion: () => opened?.sync.version ?? 0,
  open(request) {
    theme = request.theme ?? theme;
    const scene = request.scene;
    legacyOpen?.(
      scene
        ? typeof scene === "string"
          ? scene
          : JSON.stringify(scene)
        : null,
    );
  },
};

async function start() {
  let loaded: LoadedScene | null = null;
  while (!loaded) {
    try {
      loaded = await transport.load();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  const sync = new DiagramSync(transport, loaded.version);
  opened = { loaded, sync };
  render();
  if (!nativeBridge() && diagramID) {
    listenToGateway(diagramID, sync);
  }
}

void start();
