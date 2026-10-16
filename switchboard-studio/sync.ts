import {
  CaptureUpdateAction,
  getSceneVersion,
  reconcileElements,
  restoreElements,
  serializeAsJSON,
} from "@excalidraw/excalidraw";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

/**
 * Keeps an open diagram in step with the gateway's copy.
 *
 * The page saves the whole scene shortly after each change and names the gateway version it
 * was built on. If another copy saved first, the gateway refuses the save; the page then pulls
 * the newest version, merges it shape by shape with Excalidraw's own rule (the newer edit of
 * each shape wins) and saves again. When another copy saves, the page hears about it and pulls.
 * Deleted shapes stay in saved scenes for a day so other copies learn about the deletion.
 */

/** Same window excalidraw.com keeps deleted shapes for its live rooms. */
export const DELETED_SHAPE_KEPT_MS = 24 * 60 * 60 * 1000;
const SAVE_DELAY_MS = 800;
const RETRY_DELAY_MS = 5000;

export type LoadedScene = {
  /** A `.excalidraw` document, or null before the first save. */
  scene: string | null;
  version: number;
};

export type SaveResult =
  | { status: "saved"; version: number }
  | { status: "conflict"; version: number }
  | { status: "failed"; message?: string };

/** Where the scene is loaded from and saved to: the Switchboard app, or the gateway directly. */
/** What Keep or Undo on an agent proposal answered. */
export type Decision = { ok: true } | { ok: false; message: string };

export type Transport = {
  load(): Promise<LoadedScene>;
  save(scene: string, base: number): Promise<SaveResult>;
  changed(): void;
  /** Keeps or undoes an agent proposal; absent where the host cannot (older Mac apps). */
  decide?(proposal: string, action: "keep" | "undo"): Promise<Decision>;
  /** Tells the diagram agent which shapes are selected; absent where the host cannot. */
  select?(shapes: string[]): void;
};

type SceneAPI = Pick<
  ExcalidrawImperativeAPI,
  | "getSceneElementsIncludingDeleted"
  | "getAppState"
  | "getFiles"
  | "addFiles"
  | "updateScene"
>;

type SceneDocument = {
  elements?: ExcalidrawElement[];
  appState?: Partial<AppState>;
  files?: BinaryFiles;
};

export const sceneKey = (
  elements: readonly ExcalidrawElement[],
  background: string,
  files: BinaryFiles,
) => `${getSceneVersion(elements)}|${background}|${Object.keys(files).length}`;

/** The scene as saved: shapes, recently deleted shapes, background and pictures. */
export function serializeScene(api: SceneAPI, now = Date.now()): string {
  const all = api.getSceneElementsIncludingDeleted();
  const document = JSON.parse(
    serializeAsJSON(all, api.getAppState(), api.getFiles(), "local"),
  );
  const cleaned = new Map<string, ExcalidrawElement>(
    (document.elements as ExcalidrawElement[]).map((element) => [
      element.id,
      element,
    ]),
  );
  const cutoff = now - DELETED_SHAPE_KEPT_MS;
  document.elements = all
    .filter((element) => !element.isDeleted || element.updated > cutoff)
    .map((element) => cleaned.get(element.id) ?? element);
  return JSON.stringify(document);
}

export class DiagramSync {
  /** Newest gateway version this page's scene includes. */
  private base: number;
  /** Scene key when the page last matched the gateway; null until the scene opens. */
  private syncedKey: string | null = null;
  /** Background when the page last matched the gateway. */
  private syncedBackground: string | null = null;
  private lastKey: string | null = null;
  private api: SceneAPI | null = null;
  private busy = false;
  private wantPull = false;
  private wantSave = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly transport: Transport, version: number) {
    this.base = version;
  }

  get version() {
    return this.base;
  }

  attach(api: SceneAPI) {
    this.api = api;
  }

  /** Excalidraw's onChange. The first call records the scene as opened. */
  onChange(
    elements: readonly ExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) {
    const key = sceneKey(elements, appState.viewBackgroundColor, files);
    if (this.syncedKey === null) {
      this.syncedKey = key;
      this.syncedBackground = appState.viewBackgroundColor;
      this.lastKey = key;
      return;
    }
    if (key === this.lastKey) {
      return;
    }
    this.lastKey = key;
    if (key === this.syncedKey) {
      return;
    }
    this.transport.changed();
    this.schedule(SAVE_DELAY_MS);
  }

  /** Another copy saved `version`. */
  remoteChanged(version: number) {
    if (version > this.base) {
      this.refresh();
    }
  }

  /** Pull the newest version, e.g. after the connection comes back. */
  refresh() {
    this.wantPull = true;
    void this.run();
  }

  /** Save now if anything changed, e.g. before the page goes away. */
  flush() {
    this.wantSave = true;
    void this.run();
  }

  private schedule(delay: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delay);
  }

  /** One pull or save at a time, pulls first, so a save always names what it merged. */
  private async run() {
    if (this.busy || !this.api || this.syncedKey === null) {
      return;
    }
    this.busy = true;
    try {
      while (this.wantPull || this.wantSave) {
        if (this.wantPull) {
          this.wantPull = false;
          await this.pull();
        } else {
          this.wantSave = false;
          await this.save();
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private currentKey() {
    const api = this.api!;
    return sceneKey(
      api.getSceneElementsIncludingDeleted(),
      api.getAppState().viewBackgroundColor,
      api.getFiles(),
    );
  }

  private async save() {
    const api = this.api!;
    const key = this.currentKey();
    if (key === this.syncedKey) {
      return;
    }
    const background = api.getAppState().viewBackgroundColor;
    let result: SaveResult;
    try {
      result = await this.transport.save(serializeScene(api), this.base);
    } catch (error) {
      result = { status: "failed", message: String(error) };
    }
    switch (result.status) {
      case "saved":
        this.base = Math.max(this.base, result.version);
        this.syncedKey = key;
        this.syncedBackground = background;
        if (this.currentKey() !== key) {
          this.schedule(SAVE_DELAY_MS); // drawn while saving
        }
        break;
      case "conflict":
        this.wantPull = true;
        this.wantSave = true;
        break;
      case "failed":
        this.schedule(RETRY_DELAY_MS);
        break;
    }
  }

  private async pull() {
    let loaded: LoadedScene;
    try {
      loaded = await this.transport.load();
    } catch {
      setTimeout(() => this.refresh(), RETRY_DELAY_MS);
      return;
    }
    if (loaded.version <= this.base || !loaded.scene) {
      return;
    }
    if (this.merge(JSON.parse(loaded.scene) as SceneDocument)) {
      this.wantSave = true;
    }
    this.base = loaded.version;
  }

  /** Merges a newer gateway scene into the page. Returns true if the page has edits it lacks. */
  private merge(remote: SceneDocument): boolean {
    const api = this.api!;
    const appState = api.getAppState();
    const remoteElements = restoreElements(
      remote.elements ?? [],
      null,
    ) as RemoteExcalidrawElement[];
    const merged = reconcileElements(
      api.getSceneElementsIncludingDeleted(),
      remoteElements,
      appState,
    );
    const remoteByID = new Map(
      remoteElements.map((element) => [element.id, element]),
    );
    const localWins = merged.some((element) => {
      const theirs = remoteByID.get(element.id);
      return (
        !theirs ||
        theirs.version !== element.version ||
        theirs.versionNonce !== element.versionNonce
      );
    });

    const localFiles = api.getFiles();
    const missing = Object.values(remote.files ?? {}).filter(
      (file) => !localFiles[file.id],
    );
    if (missing.length > 0) {
      api.addFiles(missing);
    }

    // The background has no version: take theirs unless it was changed here since the last sync.
    const ownBackground = appState.viewBackgroundColor;
    const theirBackground =
      remote.appState?.viewBackgroundColor ?? ownBackground;
    const changedHere = ownBackground !== this.syncedBackground;
    const background = changedHere ? ownBackground : theirBackground;

    const key = sceneKey(merged, background, api.getFiles());
    this.lastKey = key; // the change below is not an edit to save
    if (!localWins && !changedHere) {
      this.syncedKey = key;
      this.syncedBackground = background;
    }
    api.updateScene({
      elements: merged,
      appState:
        background !== ownBackground
          ? { viewBackgroundColor: background }
          : undefined,
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    return localWins || changedHere;
  }
}

// ── Transports ─────────────────────────────────────────────────────────────

export type NativeBridge = { postMessage: (message: unknown) => unknown };

declare global {
  interface Window {
    webkit?: { messageHandlers?: { studio?: NativeBridge } };
  }
}

export const nativeBridge = (): NativeBridge | undefined =>
  window.webkit?.messageHandlers?.studio;

/** The Switchboard app answers each message (Mac apps built from 2026-10-15 on). */
export function nativeTransport(
  bridge: NativeBridge,
  protocol = NATIVE_PROTOCOL,
): Transport {
  return {
    load: async () =>
      (await bridge.postMessage({ type: "load" })) as LoadedScene,
    save: async (scene, base) =>
      (await bridge.postMessage({ type: "save", scene, base })) as SaveResult,
    changed: () => void bridge.postMessage({ type: "changed" }),
    decide:
      protocol >= NATIVE_PROPOSALS_PROTOCOL
        ? async (proposal, action) =>
            ((await bridge.postMessage({
              type: "proposal",
              proposal,
              action,
            })) as Decision | undefined) ?? {
              ok: false,
              message: "The app did not answer",
            }
        : undefined,
    select:
      protocol >= NATIVE_SELECTION_PROTOCOL
        ? (shapes) => void bridge.postMessage({ type: "selection", shapes })
        : undefined,
  };
}

/** Protocol version 2 answers every message with a reply. */
export const NATIVE_PROTOCOL = 2;
/** Protocol version 3 also passes Keep and Undo on agent proposals to the gateway. */
export const NATIVE_PROPOSALS_PROTOCOL = 3;
/** Protocol version 4 also passes the selection on to the diagram agent. */
export const NATIVE_SELECTION_PROTOCOL = 4;

/** The protocol the app speaks, or 0 when it cannot answer at all. */
export async function nativeBridgeProtocol(
  bridge: NativeBridge,
): Promise<number> {
  try {
    const answer = (await bridge.postMessage({ type: "hello" })) as
      | { protocol?: number }
      | undefined;
    return answer?.protocol ?? 0;
  } catch {
    return 0;
  }
}

/**
 * True when the app speaks protocol 2. WebKit returns a promise from `postMessage` even when
 * the app cannot reply (it resolves empty), so the app has to say its protocol in the answer.
 */
export async function nativeBridgeAnswers(
  bridge: NativeBridge,
): Promise<boolean> {
  return (await nativeBridgeProtocol(bridge)) >= NATIVE_PROTOCOL;
}

/**
 * Mac apps built before live updates (2026-10-15): the app opens the scene with `open()` after "ready"
 * and saves without a version, so the newest save wins and nothing arrives live.
 * Remove once every Mac runs a newer build.
 */
export function legacyNativeTransport(
  bridge: NativeBridge,
  whenOpened: (open: (scene: string | null) => void) => void,
): Transport {
  return {
    load: () =>
      new Promise((resolve) => {
        whenOpened((scene) => resolve({ scene, version: 0 }));
        bridge.postMessage({ type: "ready" });
      }),
    save: async (scene) => {
      bridge.postMessage({ type: "save", scene });
      return { status: "saved", version: 0 };
    },
    changed: () => void bridge.postMessage({ type: "changed" }),
  };
}

/** A studio opened in a browser from the gateway's `/studio/`. */
export function gatewayTransport(diagramID: string): Transport {
  const url = `../api/diagrams/${encodeURIComponent(diagramID)}/scene`;
  return {
    async load() {
      const response = await fetch(url, { cache: "no-store" });
      if (response.status === 404) {
        return { scene: null, version: 0 };
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return {
        scene: await response.text(),
        version: Number(response.headers.get("X-Diagram-Version") ?? 0),
      };
    },
    async save(scene, base) {
      const response = await fetch(`${url}?base=${base}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: scene,
      });
      const body = (await response.json().catch(() => ({}))) as {
        version?: number;
        error?: string;
      };
      if (response.ok) {
        return { status: "saved", version: body.version ?? 0 };
      }
      if (response.status === 409) {
        return { status: "conflict", version: body.version ?? 0 };
      }
      return {
        status: "failed",
        message: body.error ?? `HTTP ${response.status}`,
      };
    },
    changed() {},
    async decide(proposal, action) {
      const response = await fetch(
        `../api/diagrams/${encodeURIComponent(
          diagramID,
        )}/proposals/${encodeURIComponent(proposal)}/${action}`,
        { method: "POST" },
      );
      if (response.ok) {
        return { ok: true };
      }
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      return { ok: false, message: body.error ?? `HTTP ${response.status}` };
    },
    select(shapes) {
      void fetch(`../api/diagrams/${encodeURIComponent(diagramID)}/selection`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shapes }),
      }).catch(() => {});
    },
  };
}

/** Listens to the gateway's event stream for saves of this diagram. */
export function listenToGateway(diagramID: string, sync: DiagramSync) {
  const events = new EventSource("../api/events");
  events.addEventListener("open", () => sync.refresh());
  events.addEventListener("diagram:updated", (event) => {
    try {
      const meta = JSON.parse((event as MessageEvent<string>).data).payload as {
        id?: string;
        version?: number;
      };
      if (meta.id === diagramID && typeof meta.version === "number") {
        sync.remoteChanged(meta.version);
      }
    } catch {
      // not a diagram event we understand
    }
  });
}

/** A board opened without a diagram: nothing to load or save. */
export const scratchTransport: Transport = {
  load: async () => ({ scene: null, version: 0 }),
  save: async () => ({ status: "saved", version: 0 }),
  changed() {},
};
