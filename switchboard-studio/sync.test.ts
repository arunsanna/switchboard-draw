import { getDefaultAppState } from "@excalidraw/excalidraw/appState";
import { newElementWith } from "@excalidraw/excalidraw/element/mutateElement";
import { newElement } from "@excalidraw/excalidraw/element/newElement";
import { syncInvalidIndices } from "@excalidraw/excalidraw/fractionalIndex";

import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";

import { DELETED_SHAPE_KEPT_MS, DiagramSync, serializeScene } from "./sync";

import type { Transport } from "./sync";

/** The gateway's store: refuses a save built on an older version. */
class FakeGateway {
  version = 0;
  scene: string | null = null;
  saves = 0;

  transport(): Transport {
    return {
      load: async () => ({ scene: this.scene, version: this.version }),
      save: async (scene, base) => {
        if (base !== this.version) {
          return { status: "conflict", version: this.version };
        }
        this.version += 1;
        this.saves += 1;
        this.scene = scene;
        return { status: "saved", version: this.version };
      },
      changed() {},
    };
  }

  ids() {
    const elements = (JSON.parse(this.scene ?? "{}").elements ??
      []) as ExcalidrawElement[];
    return elements
      .filter((element) => !element.isDeleted)
      .map((element) => element.id)
      .sort();
  }
}

/** One open studio page: Excalidraw's scene plus its sync. */
class FakePage {
  elements: OrderedExcalidrawElement[] = [];
  appState = {
    ...getDefaultAppState(),
    viewBackgroundColor: "#ffffff",
  } as AppState;
  files: BinaryFiles = {};
  readonly sync: DiagramSync;
  readonly api: Parameters<DiagramSync["attach"]>[0];

  constructor(gateway: FakeGateway) {
    this.sync = new DiagramSync(gateway.transport(), gateway.version);
    this.api = {
      getSceneElementsIncludingDeleted: () => this.elements,
      getAppState: () => this.appState,
      getFiles: () => this.files,
      addFiles: (files) =>
        files.forEach((file) => (this.files[file.id] = file)),
      updateScene: ({ elements, appState }) => {
        if (elements) {
          this.elements = elements as OrderedExcalidrawElement[];
        }
        if (appState) {
          this.appState = { ...this.appState, ...appState } as AppState;
        }
        this.changed();
      },
    };
    this.sync.attach(this.api);
    this.changed(); // the scene as opened
  }

  changed() {
    this.sync.onChange(this.elements, this.appState, this.files);
  }

  draw(x: number) {
    const shape = newElement({
      type: "rectangle",
      x,
      y: 0,
      width: 40,
      height: 30,
    });
    this.elements = syncInvalidIndices([
      ...this.elements,
      shape as OrderedExcalidrawElement,
    ]);
    this.changed();
    return shape.id;
  }

  erase(id: string) {
    this.elements = this.elements.map((element) =>
      // Excalidraw stamps a fixed time in tests; deletions need a real one.
      element.id === id
        ? {
            ...newElementWith(element, { isDeleted: true }),
            updated: Date.now(),
          }
        : element,
    );
    this.changed();
  }

  setBackground(color: string) {
    this.appState = { ...this.appState, viewBackgroundColor: color };
    this.changed();
  }

  ids() {
    return this.elements
      .filter((element) => !element.isDeleted)
      .map((element) => element.id)
      .sort();
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("DiagramSync", () => {
  it("keeps both people's shapes when they draw at the same time", async () => {
    const gateway = new FakeGateway();
    const mine = new FakePage(gateway);
    const theirs = new FakePage(gateway);
    const a = mine.draw(0);
    const b = theirs.draw(100);

    mine.sync.flush();
    await settle();
    theirs.sync.flush(); // built on version 0, refused, merges version 1, saves version 2
    await settle();
    expect(gateway.version).toBe(2);
    expect(gateway.ids()).toEqual([a, b].sort());

    mine.sync.remoteChanged(gateway.version);
    await settle();
    expect(mine.ids()).toEqual([a, b].sort());
    expect(gateway.saves).toBe(2); // taking in their shape is not saved back
  });

  it("sends a deletion to the other copy", async () => {
    const gateway = new FakeGateway();
    const mine = new FakePage(gateway);
    const theirs = new FakePage(gateway);
    const a = mine.draw(0);
    mine.sync.flush();
    await settle();
    theirs.sync.remoteChanged(gateway.version);
    await settle();
    expect(theirs.ids()).toEqual([a]);

    mine.erase(a);
    mine.sync.flush();
    await settle();
    theirs.sync.remoteChanged(gateway.version);
    await settle();
    expect(theirs.ids()).toEqual([]);
    expect(gateway.ids()).toEqual([]);
  });

  it("does not take a remote copy over a shape changed here since", async () => {
    const gateway = new FakeGateway();
    const mine = new FakePage(gateway);
    const theirs = new FakePage(gateway);
    const a = mine.draw(0);
    mine.sync.flush();
    await settle();
    theirs.sync.remoteChanged(gateway.version);
    await settle();

    theirs.erase(a); // they delete it…
    mine.elements = mine.elements.map((element) =>
      newElementWith(element, { x: 500 }),
    );
    mine.elements = mine.elements.map((element) =>
      newElementWith(element, { y: 500 }),
    ); // …while it is moved twice here
    mine.changed();
    theirs.sync.flush();
    await settle();
    mine.sync.flush();
    await settle();
    theirs.sync.remoteChanged(gateway.version);
    await settle();

    expect(mine.ids()).toEqual([a]);
    expect(theirs.ids()).toEqual([a]); // the newer edit of the shape wins everywhere
    expect(gateway.ids()).toEqual([a]);
  });

  it("follows a background change without saving it back", async () => {
    const gateway = new FakeGateway();
    const mine = new FakePage(gateway);
    const theirs = new FakePage(gateway);
    theirs.setBackground("#ffc9c9");
    theirs.sync.flush();
    await settle();
    mine.sync.remoteChanged(gateway.version);
    await settle();
    expect(mine.appState.viewBackgroundColor).toBe("#ffc9c9");
    expect(gateway.saves).toBe(1);
  });

  it("drops shapes deleted more than a day ago from the saved scene", () => {
    const gateway = new FakeGateway();
    const page = new FakePage(gateway);
    const kept = page.draw(0);
    const gone = page.draw(100);
    page.erase(gone);
    const scene = (now: number) =>
      (
        JSON.parse(serializeScene(page.api, now))
          .elements as ExcalidrawElement[]
      ).map((e) => e.id);
    expect(scene(Date.now())).toEqual([kept, gone]);
    expect(scene(Date.now() + DELETED_SHAPE_KEPT_MS + 1)).toEqual([kept]);
  });
});
