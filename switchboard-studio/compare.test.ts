import { describe, expect, it } from "vitest";

import {
  changedCells,
  expectedScene,
  groupCells,
  shapeChanges,
} from "./compare";

import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

/** A white RGBA picture with the given dots painted black. */
const picture = (width: number, height: number, dots: [number, number][]) => {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const [x, y] of dots) {
    data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
  }
  return data;
};

const shape = (id: string, x: number, extra: Record<string, unknown> = {}) =>
  ({
    id,
    type: "rectangle",
    x,
    y: 0,
    version: 1,
    versionNonce: 1,
    updated: 1,
    ...extra,
  } as unknown as ExcalidrawElement);

describe("before/after comparison", () => {
  it("finds nothing when the pictures are the same", () => {
    const a = picture(64, 64, [[10, 10]]);
    const diff = changedCells(a, a.slice(), 64, 64);
    expect(diff.changedPixels).toBe(0);
    expect(groupCells(diff.cells, diff.columns, diff.rows)).toEqual([]);
  });

  it("ignores tiny colour shifts from smoothing", () => {
    const a = picture(16, 16, []);
    const b = a.slice();
    b[0] = 240; // 15 of 255
    expect(changedCells(a, b, 16, 16).changedPixels).toBe(0);
  });

  it("groups nearby changes into one area and far ones into two", () => {
    const a = picture(160, 64, []);
    const b = picture(160, 64, [
      [2, 2],
      [12, 4],
      [150, 60],
    ]);
    const diff = changedCells(a, b, 160, 64);
    expect(diff.changedPixels).toBe(3);
    const boxes = groupCells(diff.cells, diff.columns, diff.rows);
    expect(boxes).toEqual([
      { x: 0, y: 0, width: 16, height: 8 },
      { x: 144, y: 56, width: 8, height: 8 },
    ]);
  });

  it("builds the target from before plus only the asked-for shapes", () => {
    const before = [shape("api", 0), shape("login", 100), shape("title", 200)];
    const after = [shape("api", 0), shape("login", 170), shape("cache", 300)];
    const target = expectedScene(before, after, new Set(["cache"]));
    // Login stays where it was and the title comes back: neither was asked for.
    expect(target.map((element) => [element.id, element.x])).toEqual([
      ["api", 0],
      ["login", 100],
      ["cache", 300],
      ["title", 200],
    ]);
  });

  it("names shapes changed outside the request, ignoring save bookkeeping", () => {
    const before = [shape("api", 0), shape("db", 100), shape("label", 200)];
    const after = [
      shape("api", 0, {
        version: 9,
        versionNonce: 7,
        updated: 5,
        index: "a9",
        boundElements: [{ id: "arrow", type: "arrow" }],
      }), // saved again and an arrow attached: same look
      shape("db", 140), // moved, nobody asked
      shape("cache", 300), // the requested new box
    ];
    const changes = shapeChanges(before, after, new Set(["cache"]));
    expect(changes).toEqual({
      added: ["cache"],
      changed: ["db"],
      removed: ["label"],
      unexpected: ["db", "label"],
    });
  });
});
