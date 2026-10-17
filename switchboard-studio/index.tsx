import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
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
  NATIVE_PROTOCOL,
  nativeBridge,
  nativeBridgeProtocol,
  nativeTransport,
  scratchTransport,
  serializeScene,
} from "./sync";
import { buildScene } from "./build";
import { compareScenes } from "./compare";
import { ProposalLayer } from "./proposals";
import { SelectionReporter } from "./selection";
import { renderPictures } from "./render";

import type { LoadedScene, Transport } from "./sync";
import type { Built, Ops } from "./build";
import type { Comparison } from "./compare";
import type { ProposalLayerHandle } from "./proposals";
import type { Pictures } from "./render";

type Theme = "light" | "dark";

/** Mac apps built before live updates (2026-10-15) open the scene with this call. */
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
      /** Selects these shapes, as if Arun had clicked them. */
      select: (ids: readonly string[]) => void;
      /** Points of the page's right edge the app's floating agent tray covers. */
      setRightInset?: (points: number) => void;
    };
    /** Set with `?render=1`: Jarvis's Renderer draws list pictures through it. */
    switchboardRender?: (scene: string, maxSize?: number) => Promise<Pictures>;
    /** Set with `?render=1`: the agent's changes, applied and checked against the rules. */
    switchboardBuild?: (base: string, ops: Ops) => Promise<Built>;
    /** Set with `?render=1`: before/after comparison for the agent's checks. */
    switchboardCompare?: (
      before: string,
      after: string,
      expected?: readonly string[],
    ) => Promise<Comparison>;
  }
}

const RETRY_DELAY_MS = 5000;
const params = new URLSearchParams(window.location.search);
const diagramID = params.get("diagram");

let legacyOpen: ((scene: string | null) => void) | null = null;
/** Points of the page's right edge the app's floating agent tray covers; fitting leaves it clear. */
let rightInset = 0;

const FIT_ICON =
  "M17 4h3c1.1 0 2 .9 2 2v2h-2V6h-3V4zM4 8V6h3V4H4c-1.1 0-2 .9-2 2v2h2zm16 8v2h-3v2h3c1.1 0 2-.9 2-2v-2h-2zM7 18H4v-2H2v2c0 1.1.9 2 2 2h3v-2zM18 8H6v8h12V8z";

/** The Fit button beside the Library button, in the same Liquid Glass as the app's controls. */
const FitButton = ({ theme, fit }: { theme: Theme; fit: () => void }) => (
  <button
    type="button"
    className="sb-fit"
    title="Fit"
    aria-label="Fit"
    onClick={fit}
    style={{
      width: 36,
      height: 36,
      padding: 0,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: "50%",
      cursor: "pointer",
      color: theme === "dark" ? "#f0f0f0" : "#1f1f1f",
      background:
        theme === "dark" ? "rgba(34, 34, 38, 0.42)" : "rgba(250, 250, 252, 0.5)",
      border: `1px solid ${
        theme === "dark" ? "rgba(255, 255, 255, 0.12)" : "rgba(255, 255, 255, 0.7)"
      }`,
      boxShadow: "0 1px 3px rgba(0, 0, 0, 0.08), 0 8px 24px rgba(0, 0, 0, 0.16)",
      backdropFilter: "blur(16px) saturate(180%)",
      WebkitBackdropFilter: "blur(16px) saturate(180%)",
    }}
  >
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
      <path d={FIT_ICON} />
    </svg>
  </button>
);

async function makeTransport(): Promise<Transport> {
  const bridge = nativeBridge();
  if (bridge) {
    const protocol = await nativeBridgeProtocol(bridge);
    return protocol >= NATIVE_PROTOCOL
      ? nativeTransport(bridge, protocol)
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
  transport,
  theme,
}: {
  loaded: LoadedScene;
  sync: DiagramSync;
  transport: Transport;
  theme: Theme;
}) => {
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const proposals = useRef<ProposalLayerHandle | null>(null);
  const [initialData] = useState(() => initialDataFrom(loaded.scene));
  const [selection] = useState(() =>
    transport.select ? new SelectionReporter(transport.select) : null,
  );
  // Until Arun pans, zooms, clicks or types, a new tray inset fits the drawing again.
  const viewTouched = useRef(false);

  /** The whole drawing, centred, never zoomed in past 100%, clear of the agent's tray. */
  const fit = useCallback(() => {
    const instance = api.current;
    if (!instance || instance.getSceneElements().length === 0) {
      return;
    }
    instance.scrollToContent(undefined, {
      fitToContent: true,
      maxZoom: 1,
      animate: false,
      // clear of Excalidraw's toolbar and bottom controls, with a margin at the sides
      canvasOffsets: { top: 72, bottom: 64, left: 32, right: rightInset + 32 },
    });
  }, []);

  useEffect(() => {
    const touched = () => (viewTouched.current = true);
    const events = ["pointerdown", "wheel", "keydown"] as const;
    events.forEach((type) =>
      document.addEventListener(type, touched, { capture: true }),
    );
    return () =>
      events.forEach((type) =>
        document.removeEventListener(type, touched, { capture: true }),
      );
  }, []);

  useEffect(() => {
    window.switchboardStudio!.getScene = () =>
      api.current ? serializeScene(api.current) : null;
    window.switchboardStudio!.select = (ids) =>
      api.current?.updateScene({
        appState: {
          selectedElementIds: Object.fromEntries(ids.map((id) => [id, true])),
        },
      });
    window.switchboardStudio!.setRightInset = (points) => {
      rightInset = points;
      if (!viewTouched.current) {
        fit();
      }
    };
  }, [fit]);

  return (
    <>
      <Excalidraw
        initialData={initialData}
        excalidrawAPI={(instance) => {
          api.current = instance;
          sync.attach(instance);
          setTimeout(() => {
            fit();
            proposals.current?.update(
              instance.getSceneElements(),
              instance.getAppState(),
            );
          });
        }}
        renderTopRightUI={() => <FitButton theme={theme} fit={fit} />}
        onChange={(elements, appState, files) => {
          sync.onChange(elements, appState, files);
          proposals.current?.update(elements, appState);
          selection?.update(elements, appState);
        }}
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
      <ProposalLayer
        ref={proposals}
        theme={theme}
        decide={transport.decide}
        decided={() => sync.refresh()}
      />
    </>
  );
};

const root = createRoot(document.getElementById("root")!);
let theme: Theme = params.get("theme") === "dark" ? "dark" : "light";
let opened: {
  loaded: LoadedScene;
  sync: DiagramSync;
  transport: Transport;
} | null = null;

function render() {
  if (!opened) {
    return;
  }
  root.render(
    <StrictMode>
      <Studio
        loaded={opened.loaded}
        sync={opened.sync}
        transport={opened.transport}
        theme={theme}
      />
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
  select: () => {},
  setRightInset(points) {
    rightInset = points;
  },
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
  const transport = await makeTransport();
  let loaded: LoadedScene | null = null;
  while (!loaded) {
    try {
      loaded = await transport.load();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  const sync = new DiagramSync(transport, loaded.version);
  opened = { loaded, sync, transport };
  render();
  if (!nativeBridge() && diagramID) {
    listenToGateway(diagramID, sync);
  }
}

if (params.get("render") === "1") {
  window.switchboardRender = renderPictures;
  window.switchboardCompare = compareScenes;
  window.switchboardBuild = buildScene;
} else {
  void start();
}
