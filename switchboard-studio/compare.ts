import { exportToCanvas, restoreElements } from "@excalidraw/excalidraw";
import { getCommonBounds } from "@excalidraw/excalidraw/element/bounds";
import { arrayToMap } from "@excalidraw/excalidraw/utils";

import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

/** A changed area, in scene units, and whether the change was meant to touch it. */
export type Region = {
  x: number;
  y: number;
  width: number;
  height: number;
  expected: boolean;
};

export type Comparison = {
  /** Anything differs, in the picture or in the shapes. */
  changed: boolean;
  /** Share of the picture's dots that differ, 0–100. */
  changedPercent: number;
  regions: Region[];
  /** Number of regions outside the shapes the change was meant to touch. */
  unexpected: number;
  shapes: {
    added: string[];
    changed: string[];
    removed: string[];
    /** Added, changed or removed shapes that were not expected to change. */
    unexpected: string[];
  };
  /** How picture pixels map to the scene: scene = origin + pixel / scale. */
  frame: {
    width: number;
    height: number;
    scale: number;
    originX: number;
    originY: number;
  };
  /** PNG data URLs: both versions on one frame, and the after picture with areas marked. */
  before: string;
  after: string;
  highlight: string;
};

type Scene = {
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
};

const PADDING = 16;
const MAX_SIZE = 1600;
/** A dot counts as changed when a colour channel moves by more than this (of 255). */
const TOLERANCE = 32;
/** Changed dots are grouped in cells of this many pixels; nearby cells join one area. */
const CELL = 8;
/** Changed cells up to this many cells apart join one area (word gaps, dashed lines). */
const JOIN = 4;
/**
 * Fields that change without changing how a shape looks: save bookkeeping, the list of
 * arrows and text attached to it (connecting an arrow to a box does not change the box), and
 * the drawing-order key Excalidraw renumbers when shapes come and go (a real reorder still
 * shows in the pictures).
 */
const VOLATILE = new Set([
  "updated",
  "version",
  "versionNonce",
  "boundElements",
  "index",
]);

/**
 * Compares two versions of a diagram the way the agent needs. Three pictures are drawn with
 * Excalidraw's export on one frame (the union of both drawings, same scale): before, after,
 * and the target, which is before with only the `expected` shapes (ids the change was meant
 * to touch, with their text and attached arrows) taken from after. Before against target gives
 * the expected areas; target against after gives every change nobody asked for.
 */
export async function compareScenes(
  beforeJSON: string,
  afterJSON: string,
  expected: readonly string[] = [],
): Promise<Comparison> {
  const before = parseScene(beforeJSON);
  const after = parseScene(afterJSON);
  const all = [...before.elements, ...after.elements];
  const expectedIDs = withAttached(expected, all);
  const target: Scene = {
    elements: expectedScene(before.elements, after.elements, expectedIDs),
    appState: after.appState,
    files: { ...before.files, ...after.files },
  };
  const [minX, minY, maxX, maxY] = getCommonBounds(all, arrayToMap(all));
  const width = Math.max(maxX - minX, 1);
  const height = Math.max(maxY - minY, 1);
  const scale = Math.min(2, MAX_SIZE / Math.max(width, height));
  // Two invisible corner marks give every export the same frame, so unchanged shapes land
  // on the same pixels.
  const anchors = [
    anchor("compare-anchor-start", minX, minY),
    anchor("compare-anchor-end", maxX - 1, maxY - 1),
  ];
  const draw = async (scene: Scene) =>
    exportToCanvas({
      elements: [...scene.elements, ...anchors],
      files: scene.files,
      appState: {
        ...scene.appState,
        exportBackground: true,
        exportWithDarkMode: false,
      },
      exportPadding: PADDING,
      getDimensions: (w, h) => ({
        width: Math.round(w * scale),
        height: Math.round(h * scale),
        scale,
      }),
    });
  const beforeCanvas = await draw(before);
  const targetCanvas = await draw(target);
  const afterCanvas = await draw(after);
  const frame = {
    width: afterCanvas.width,
    height: afterCanvas.height,
    scale,
    originX: minX - PADDING,
    originY: minY - PADDING,
  };

  const [a, t, b] = [beforeCanvas, targetCanvas, afterCanvas].map(pixels);
  const regionsOf = (diff: ReturnType<typeof changedCells>, wanted: boolean) =>
    groupCells(diff.cells, diff.columns, diff.rows).map((box) => ({
      x: frame.originX + box.x / scale,
      y: frame.originY + box.y / scale,
      width: box.width / scale,
      height: box.height / scale,
      expected: wanted,
    }));
  const regions = [
    ...regionsOf(changedCells(a, t, frame.width, frame.height), true),
    ...regionsOf(changedCells(t, b, frame.width, frame.height), false),
  ];
  const total = changedCells(a, b, frame.width, frame.height);
  const shapes = shapeChanges(before.elements, after.elements, expectedIDs);
  return {
    changed:
      total.changedPixels > 0 ||
      shapes.added.length + shapes.changed.length + shapes.removed.length > 0,
    changedPercent:
      (100 * total.changedPixels) / Math.max(frame.width * frame.height, 1),
    regions,
    unexpected: regions.filter((region) => !region.expected).length,
    shapes,
    frame,
    before: beforeCanvas.toDataURL("image/png"),
    after: afterCanvas.toDataURL("image/png"),
    highlight: highlighted(afterCanvas, regions, frame).toDataURL("image/png"),
  };
}

/**
 * The after version as it should be if only the expected shapes changed: after's order, with
 * every other shape as it was before, and shapes that vanished unasked put back.
 */
export function expectedScene(
  before: readonly ExcalidrawElement[],
  after: readonly ExcalidrawElement[],
  expected: ReadonlySet<string>,
): ExcalidrawElement[] {
  const old = new Map(before.map((element) => [element.id, element]));
  const now = new Set(after.map((element) => element.id));
  const kept = after.flatMap((element) =>
    expected.has(element.id)
      ? [element]
      : old.has(element.id)
      ? [old.get(element.id)!]
      : [],
  );
  const lost = before.filter(
    (element) => !now.has(element.id) && !expected.has(element.id),
  );
  return [...kept, ...lost];
}

function parseScene(json: string): Scene {
  const parsed = JSON.parse(json) as {
    elements?: ExcalidrawElement[];
    appState?: Partial<AppState>;
    files?: BinaryFiles;
  };
  return {
    elements: restoreElements(parsed.elements ?? [], null).filter(
      (element) => !element.isDeleted,
    ),
    appState: parsed.appState ?? {},
    files: parsed.files ?? {},
  };
}

function anchor(id: string, x: number, y: number): ExcalidrawElement {
  return restoreElements(
    [
      {
        id,
        type: "rectangle",
        x,
        y,
        width: 1,
        height: 1,
        opacity: 0,
        strokeColor: "transparent",
        backgroundColor: "transparent",
      } as unknown as ExcalidrawElement,
    ],
    null,
  )[0];
}

/** Expected shapes, plus the text inside them and the arrows attached to them. */
function withAttached(
  expected: readonly string[],
  elements: readonly ExcalidrawElement[],
): Set<string> {
  const ids = new Set(expected);
  for (const element of elements) {
    const container = "containerId" in element ? element.containerId : null;
    const start =
      "startBinding" in element ? element.startBinding?.elementId : undefined;
    const end =
      "endBinding" in element ? element.endBinding?.elementId : undefined;
    if (
      (container && ids.has(container)) ||
      (start && ids.has(start)) ||
      (end && ids.has(end))
    ) {
      ids.add(element.id);
    }
  }
  return ids;
}

function pixels(canvas: HTMLCanvasElement): Uint8ClampedArray {
  return canvas
    .getContext("2d")!
    .getImageData(0, 0, canvas.width, canvas.height).data;
}

/** Marks every cell that holds at least one changed dot. Pictures share one size. */
export function changedCells(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  width: number,
  height: number,
) {
  const columns = Math.ceil(width / CELL);
  const rows = Math.ceil(height / CELL);
  const cells = new Uint8Array(columns * rows);
  let changedPixels = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (
        Math.abs(a[i] - b[i]) > TOLERANCE ||
        Math.abs(a[i + 1] - b[i + 1]) > TOLERANCE ||
        Math.abs(a[i + 2] - b[i + 2]) > TOLERANCE ||
        Math.abs(a[i + 3] - b[i + 3]) > TOLERANCE
      ) {
        changedPixels++;
        cells[Math.floor(y / CELL) * columns + Math.floor(x / CELL)] = 1;
      }
    }
  }
  return { cells, columns, rows, changedPixels };
}

/** Groups marked cells into areas, joining cells up to `JOIN` cells apart. Returns pixel boxes. */
export function groupCells(cells: Uint8Array, columns: number, rows: number) {
  const seen = new Uint8Array(cells.length);
  const boxes: { x: number; y: number; width: number; height: number }[] = [];
  for (let start = 0; start < cells.length; start++) {
    if (!cells[start] || seen[start]) {
      continue;
    }
    let [left, top, right, bottom] = [columns, rows, -1, -1];
    const queue = [start];
    seen[start] = 1;
    while (queue.length) {
      const cell = queue.pop()!;
      const cx = cell % columns;
      const cy = Math.floor(cell / columns);
      [left, top] = [Math.min(left, cx), Math.min(top, cy)];
      [right, bottom] = [Math.max(right, cx), Math.max(bottom, cy)];
      for (let dy = -JOIN; dy <= JOIN; dy++) {
        for (let dx = -JOIN; dx <= JOIN; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          const next = ny * columns + nx;
          if (
            nx >= 0 &&
            ny >= 0 &&
            nx < columns &&
            ny < rows &&
            cells[next] &&
            !seen[next]
          ) {
            seen[next] = 1;
            queue.push(next);
          }
        }
      }
    }
    boxes.push({
      x: left * CELL,
      y: top * CELL,
      width: (right - left + 1) * CELL,
      height: (bottom - top + 1) * CELL,
    });
  }
  return boxes;
}

/** Which shapes were added, changed or removed, ignoring fields that change on every save. */
export function shapeChanges(
  before: readonly ExcalidrawElement[],
  after: readonly ExcalidrawElement[],
  expected: ReadonlySet<string>,
) {
  const look = (element: ExcalidrawElement) =>
    JSON.stringify(
      Object.keys(element)
        .filter((key) => !VOLATILE.has(key))
        .sort()
        .map((key) => [key, element[key as keyof ExcalidrawElement]]),
    );
  const old = new Map(before.map((element) => [element.id, element]));
  const now = new Map(after.map((element) => [element.id, element]));
  const added = [...now.keys()].filter((id) => !old.has(id));
  const removed = [...old.keys()].filter((id) => !now.has(id));
  const changed = [...now.keys()].filter(
    (id) => old.has(id) && look(old.get(id)!) !== look(now.get(id)!),
  );
  const unexpected = [...added, ...changed, ...removed].filter(
    (id) => !expected.has(id),
  );
  return { added, changed, removed, unexpected };
}

/** The after picture, faded, with unexpected areas outlined in red and expected in green. */
function highlighted(
  source: HTMLCanvasElement,
  regions: readonly Region[],
  frame: Comparison["frame"],
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext("2d")!;
  context.drawImage(source, 0, 0);
  context.fillStyle = "rgba(255, 255, 255, 0.45)";
  context.fillRect(0, 0, canvas.width, canvas.height);
  for (const region of regions) {
    context.strokeStyle = region.expected ? "#2f9e44" : "#e03131";
    context.lineWidth = region.expected ? 2 : 4;
    context.strokeRect(
      (region.x - frame.originX) * frame.scale - 4,
      (region.y - frame.originY) * frame.scale - 4,
      region.width * frame.scale + 8,
      region.height * frame.scale + 8,
    );
  }
  return canvas;
}
