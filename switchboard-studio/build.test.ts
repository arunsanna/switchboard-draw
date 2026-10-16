import { describe, expect, it } from "vitest";

import {
  checkRules,
  crosses,
  edgePoint,
  freeSpot,
  layeredLayout,
} from "./build";

import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

const box = (id: string, x: number, y: number, width = 160, height = 80) =>
  ({
    id,
    type: "rectangle",
    x,
    y,
    width,
    height,
    isDeleted: false,
  } as unknown as ExcalidrawElement);

const label = (id: string, container: string, x: number, y: number) =>
  ({
    id,
    type: "text",
    text: id,
    containerId: container,
    x,
    y,
    width: 40,
    height: 25,
    isDeleted: false,
  } as unknown as ExcalidrawElement);

const arrow = (
  id: string,
  from: string | null,
  to: string | null,
  [x1, y1]: number[],
  [x2, y2]: number[],
) =>
  ({
    id,
    type: "arrow",
    x: x1,
    y: y1,
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
    points: [
      [0, 0],
      [x2 - x1, y2 - y1],
    ],
    startBinding: from ? { elementId: from } : null,
    endBinding: to ? { elementId: to } : null,
    isDeleted: false,
  } as unknown as ExcalidrawElement);

describe("laying out new boxes", () => {
  const sizes = ["client", "api", "db", "cache"].map((id) => ({
    id,
    width: 160,
    height: 80,
  }));

  it("puts each box one layer after the boxes pointing at it", () => {
    const spots = layeredLayout(
      sizes,
      [
        ["client", "api"],
        ["api", "db"],
        ["api", "cache"],
      ],
      "right",
    );
    expect(spots.get("client")!.x).toBe(0);
    expect(spots.get("api")!.x).toBe(300);
    expect(spots.get("db")!.x).toBe(600);
    expect(spots.get("cache")!.x).toBe(600);
    expect(spots.get("db")!.y).not.toBe(spots.get("cache")!.y);
  });

  it("survives loops and flows downwards when asked", () => {
    const spots = layeredLayout(
      sizes.slice(0, 2),
      [
        ["client", "api"],
        ["api", "client"],
      ],
      "down",
    );
    expect(spots.get("client")).toEqual({ x: 0, y: 0 });
    expect(spots.get("api")).toEqual({ x: 0, y: 220 });
  });

  it("places a new box beside its neighbour, around anything already there", () => {
    const api = { x: 0, y: 0, width: 160, height: 80 };
    const db = { x: 300, y: 0, width: 160, height: 80 };
    const cache = { x: 0, y: 0, width: 160, height: 80 };
    expect(freeSpot(cache, api, [api], "right")).toEqual({ x: 300, y: 0 });
    // The spot right of the API is taken by the database: go across instead.
    expect(freeSpot(cache, api, [api, db], "right")).toEqual({
      x: 300,
      y: 150,
    });
  });
});

describe("arrows", () => {
  it("start and end on the outline of each box, a little away from it", () => {
    const rect = { x: 0, y: 0, width: 200, height: 100 };
    expect(edgePoint(rect, { x: 500, y: 50 })).toEqual({ x: 208, y: 50 });
    const ellipse = { ...rect, type: "ellipse" };
    expect(edgePoint(ellipse, { x: 100, y: 500 })).toEqual({ x: 100, y: 108 });
  });

  it("know when they pass through a box", () => {
    const middle = { x: 200, y: 0, width: 100, height: 100 };
    expect(crosses({ x: 0, y: 50 }, { x: 500, y: 50 }, middle)).toBe(true);
    expect(crosses({ x: 0, y: 150 }, { x: 500, y: 150 }, middle)).toBe(false);
  });
});

describe("the rules", () => {
  it("pass a clean diagram", () => {
    const shapes = [
      box("api", 0, 0),
      box("db", 300, 0),
      arrow("api-db", "api", "db", [168, 40], [292, 40]),
    ];
    expect(checkRules(shapes, new Set(["api", "db", "api-db"]))).toEqual({
      issues: [],
      preexisting: 0,
    });
  });

  it("name every break in touched shapes and only count the others", () => {
    const shapes = [
      box("api", 0, 0),
      box("db", 120, 40), // overlaps the API
      box("login", 2000, 2000), // far away, no arrows
      box("old-a", 0, 500),
      box("old-b", 100, 520), // an overlap nobody touched
      box("vpc", -50, -50, 600, 300), // drawn around the API: fine
      label("db-label", "db", 120, 40),
      arrow("dangling", "api", null, [168, 40], [260, 200]),
      label("too-wide", "api", -40, 10),
    ];
    const { issues, preexisting } = checkRules(
      shapes,
      new Set(["api", "db", "login", "dangling"]),
    );
    expect(issues.map((issue) => issue.rule).sort()).toEqual([
      "arrow-connected",
      "overlap",
      "stranded",
      "text-fits",
    ]);
    expect(issues.find((i) => i.rule === "overlap")!.message).toBe(
      '"too-wide" and "db-label" overlap',
    );
    expect(preexisting).toBe(1);
  });

  it("catch an arrow running through another box", () => {
    const shapes = [
      box("client", 0, 0),
      box("api", 300, 0),
      box("db", 600, 0),
      arrow("client-db", "client", "db", [168, 40], [592, 40]),
    ];
    const { issues } = checkRules(shapes, new Set(["client-db"]));
    expect(issues).toEqual([
      {
        rule: "runs-through",
        shapes: ["client-db", "api"],
        message: "The arrow from client to db runs through api",
      },
    ]);
  });
});
