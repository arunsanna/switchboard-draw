import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import { FONT_FAMILY } from "@excalidraw/excalidraw/constants";
import {
  newArrowElement,
  newTextElement,
} from "@excalidraw/excalidraw/element/newElement";
import { redrawTextBoundingBox } from "@excalidraw/excalidraw/element/textElement";
import { measureText } from "@excalidraw/excalidraw/element/textMeasurements";
import { Fonts } from "@excalidraw/excalidraw/fonts/Fonts";
import { syncInvalidIndices } from "@excalidraw/excalidraw/fractionalIndex";
import { randomInteger } from "@excalidraw/excalidraw/random";
import { arrayToMap, getFontString } from "@excalidraw/excalidraw/utils";
import { pointFrom } from "@excalidraw/math";

import type { LocalPoint } from "@excalidraw/math";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawArrowElement,
  ExcalidrawElement,
  ExcalidrawTextElement,
} from "@excalidraw/excalidraw/element/types";

/**
 * The agent's way to change a diagram: plain boxes, arrows and texts instead of raw
 * Excalidraw elements. Ids are the agent's own names for new shapes ("api", "db").
 */
export type Ops = {
  /** Which way new, unplaced boxes flow: left to right (default) or top to bottom. */
  direction?: "right" | "down";
  add?: {
    boxes?: {
      id: string;
      label: string;
      shape?: "rectangle" | "ellipse" | "diamond";
      color?: string;
      x?: number;
      y?: number;
    }[];
    arrows?: {
      id?: string;
      from: string;
      to: string;
      label?: string;
      dashed?: boolean;
    }[];
    texts?: {
      id: string;
      text: string;
      x?: number;
      y?: number;
      size?: number;
    }[];
  };
  change?: {
    id: string;
    label?: string;
    color?: string;
    x?: number;
    y?: number;
  }[];
  /** Boxes go with their labels and arrows; arrows with their labels. */
  remove?: string[];
};

export type Issue = { rule: string; shapes: string[]; message: string };

export type Built = {
  /** The new scene, or null when the ops could not be applied (see `errors`). */
  scene: string | null;
  /** Every shape added, changed or removed, attached labels and arrows included. */
  touched: string[];
  /** Rule breaks involving touched shapes. */
  issues: Issue[];
  /** Rule breaks among shapes nobody touched; never blocking. */
  preexisting: number;
  errors: string[];
};

type Shape = ExcalidrawElement;
type Box = { x: number; y: number; width: number; height: number };

/** Excalidraw's own palette, by plain names, for box fills. */
const COLORS: Record<string, string> = {
  blue: "#a5d8ff",
  green: "#b2f2bb",
  yellow: "#ffec99",
  red: "#ffc9c9",
  orange: "#ffd8a8",
  violet: "#d0bfff",
  purple: "#eebefa",
  pink: "#fcc2d7",
  cyan: "#99e9f2",
  teal: "#96f2d7",
  gray: "#e9ecef",
  grey: "#e9ecef",
  white: "#ffffff",
  none: "transparent",
};
const BOX_TYPES = new Set(["rectangle", "ellipse", "diamond"]);
const SOLID_TYPES = new Set([
  "rectangle",
  "ellipse",
  "diamond",
  "image",
  "embeddable",
  "iframe",
]);
const GAP = { along: 140, across: 70 };
const ARROW_GAP = 8;
const FONT_SIZE = 20;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** A box this far (scene units) from every other, with no arrow, is stranded. */
const STRANDED = 600;

const colorOf = (name: string | undefined) =>
  name === undefined
    ? undefined
    : COLORS[name.toLowerCase()] ??
      (/^#[0-9a-fA-F]{6}$/.test(name) ? name : undefined);

/** Applies `ops` to a saved scene and checks the result against the rules. */
export async function buildScene(baseJSON: string, ops: Ops): Promise<Built> {
  const base = JSON.parse(baseJSON) as {
    elements?: ExcalidrawElement[];
    appState?: Partial<AppState>;
    files?: BinaryFiles;
  };
  const elements: Shape[] = (base.elements ?? []).map((element) => ({
    ...element,
  }));
  const errors: string[] = [];
  const touched = new Set<string>();
  const changed = new Set<string>(); // existing shapes whose fields change
  const byID = () => new Map(elements.map((element) => [element.id, element]));
  const live = (id: string) => {
    const element = byID().get(id);
    return element && !element.isDeleted ? element : undefined;
  };
  const labelOf = (container: Shape) =>
    elements.find(
      (element): element is ExcalidrawTextElement =>
        !element.isDeleted &&
        element.type === "text" &&
        element.containerId === container.id,
    );
  const attachedArrows = (box: Shape) =>
    elements.filter(
      (element): element is ExcalidrawArrowElement =>
        !element.isDeleted &&
        element.type === "arrow" &&
        (element.startBinding?.elementId === box.id ||
          element.endBinding?.elementId === box.id),
    );
  const deleteShape = (element: Shape) => {
    Object.assign(element, { isDeleted: true });
    touched.add(element.id);
    changed.add(element.id);
  };

  // 1. Remove.
  for (const id of ops.remove ?? []) {
    const element = live(id);
    if (!element) {
      errors.push(`remove: no shape "${id}"`);
      continue;
    }
    const label = labelOf(element);
    if (BOX_TYPES.has(element.type) || SOLID_TYPES.has(element.type)) {
      for (const arrow of attachedArrows(element)) {
        const arrowLabel = labelOf(arrow);
        deleteShape(arrow);
        if (arrowLabel) {
          deleteShape(arrowLabel);
        }
      }
    }
    deleteShape(element);
    if (label) {
      deleteShape(label);
    }
  }

  // 2. Change.
  await loadFonts();
  const moved = new Set<string>();
  for (const change of ops.change ?? []) {
    const element = live(change.id);
    if (!element) {
      errors.push(`change: no shape "${change.id}"`);
      continue;
    }
    touched.add(element.id);
    changed.add(element.id);
    const fill = colorOf(change.color);
    if (change.color !== undefined && !fill) {
      errors.push(`change ${change.id}: unknown color "${change.color}"`);
    } else if (fill) {
      Object.assign(element, { backgroundColor: fill, fillStyle: "solid" });
    }
    if (change.x !== undefined || change.y !== undefined) {
      const dx = (change.x ?? element.x) - element.x;
      const dy = (change.y ?? element.y) - element.y;
      Object.assign(element, { x: element.x + dx, y: element.y + dy });
      const label = labelOf(element);
      if (label) {
        Object.assign(label, { x: label.x + dx, y: label.y + dy });
        touched.add(label.id);
        changed.add(label.id);
      }
      moved.add(element.id);
    }
    if (change.label !== undefined) {
      if (element.type === "text") {
        Object.assign(element, {
          text: change.label,
          originalText: change.label,
        });
        redrawTextBoundingBox(element, null, arrayToMap(elements));
      } else {
        let label = labelOf(element);
        if (!label) {
          label = newTextElement({
            text: change.label,
            containerId: element.id,
            textAlign: "center",
            verticalAlign: "middle",
            fontSize: element.type === "arrow" ? 16 : FONT_SIZE,
            x: element.x,
            y: element.y,
          });
          elements.push(label);
          Object.assign(element, {
            boundElements: [
              ...(element.boundElements ?? []),
              { id: label.id, type: "text" },
            ],
          });
        }
        Object.assign(label, {
          text: change.label,
          originalText: change.label,
        });
        redrawTextBoundingBox(label, element, arrayToMap(elements));
        touched.add(label.id);
        changed.add(label.id);
      }
    }
  }

  // 3. Add boxes, sized to their labels, then place the ones without a position.
  const added = ops.add ?? {};
  const taken = new Set(elements.map((element) => element.id));
  const fresh: Shape[] = [];
  for (const box of added.boxes ?? []) {
    if (!ID_PATTERN.test(box.id) || taken.has(box.id)) {
      errors.push(
        `add box: id "${box.id}" is not free (letters, digits, - and _)`,
      );
      continue;
    }
    const fill = colorOf(box.color ?? "white");
    if (!fill) {
      errors.push(`add box ${box.id}: unknown color "${box.color}"`);
      continue;
    }
    taken.add(box.id);
    const shape = box.shape ?? "rectangle";
    const textWidth = measureText(
      box.label,
      getFontString({
        fontSize: FONT_SIZE,
        fontFamily: FONT_FAMILY.Excalifont,
      }),
      1.25 as ExcalidrawTextElement["lineHeight"],
    ).width;
    const round = shape === "rectangle" ? 1 : 1.45;
    const width = Math.round(
      Math.min(Math.max(textWidth + 60, 160), 300) * round,
    );
    const [container, label] = convertToExcalidrawElements(
      [
        {
          type: shape,
          id: box.id,
          x: box.x ?? 0,
          y: box.y ?? 0,
          width,
          height: Math.round(80 * round),
          backgroundColor: fill,
          fillStyle: "solid",
          strokeColor: "#1e1e1e",
          roundness: shape === "rectangle" ? { type: 3 } : null,
          label: { text: box.label, fontSize: FONT_SIZE },
        },
      ],
      { regenerateIds: false },
    );
    elements.push(container, label);
    fresh.push(container);
    touched.add(container.id).add(label.id);
  }
  const arrowOps = (added.arrows ?? []).filter((arrow) => {
    const ok = live(arrow.from) && live(arrow.to);
    if (!ok) {
      errors.push(
        `add arrow ${arrow.from} → ${arrow.to}: both ends must be boxes`,
      );
    }
    return ok;
  });
  const unplaced = fresh.filter((box) => {
    const asked = (added.boxes ?? []).find((b) => b.id === box.id);
    return asked?.x === undefined || asked?.y === undefined;
  });
  placeBoxes(
    elements,
    unplaced,
    arrowOps.map((arrow) => [arrow.from, arrow.to]),
    ops.direction ?? "right",
  );

  // 4. Add texts (titles, notes).
  const solid = () =>
    elements.filter((e) => !e.isDeleted && SOLID_TYPES.has(e.type));
  for (const text of added.texts ?? []) {
    if (!ID_PATTERN.test(text.id) || taken.has(text.id)) {
      errors.push(`add text: id "${text.id}" is not free`);
      continue;
    }
    taken.add(text.id);
    const [left, top] = bounds(solid());
    const element = newTextElement({
      text: text.text,
      fontSize: text.size ?? 28,
      x: text.x ?? left,
      y: text.y ?? top - 70,
    });
    Object.assign(element, { id: text.id });
    elements.push(element);
    touched.add(element.id);
  }

  // 5. Add arrows, then redraw arrows whose boxes moved.
  for (const arrow of arrowOps) {
    const id = arrow.id ?? `${arrow.from}-${arrow.to}`;
    if (!ID_PATTERN.test(id) || taken.has(id)) {
      errors.push(`add arrow: id "${id}" is not free`);
      continue;
    }
    taken.add(id);
    const from = live(arrow.from)!;
    const to = live(arrow.to)!;
    const element = newArrowElement({
      type: "arrow",
      x: 0,
      y: 0,
      strokeColor: "#1e1e1e",
      strokeStyle: arrow.dashed ? "dashed" : "solid",
      endArrowhead: "arrow",
      startArrowhead: null,
      points: [pointFrom<LocalPoint>(0, 0), pointFrom<LocalPoint>(1, 0)],
    });
    Object.assign(element, {
      id,
      startBinding: { elementId: from.id, focus: 0, gap: ARROW_GAP },
      endBinding: { elementId: to.id, focus: 0, gap: ARROW_GAP },
    });
    for (const end of [from, to]) {
      Object.assign(end, {
        boundElements: [...(end.boundElements ?? []), { id, type: "arrow" }],
      });
      changed.add(end.id); // a newer version, so live sync takes the new binding
    }
    elements.push(element);
    route(element, from, to);
    touched.add(id);
    if (arrow.label) {
      const label = newTextElement({
        text: arrow.label,
        containerId: id,
        fontSize: 16,
        textAlign: "center",
        verticalAlign: "middle",
        x: element.x,
        y: element.y,
      });
      Object.assign(element, {
        boundElements: [{ id: label.id, type: "text" }],
      });
      elements.push(label);
      redrawTextBoundingBox(label, element, arrayToMap(elements));
      touched.add(label.id);
    }
  }
  for (const id of moved) {
    for (const arrow of attachedArrows(byID().get(id)!)) {
      const from = live(arrow.startBinding!.elementId);
      const to = live(arrow.endBinding!.elementId);
      if (from && to) {
        route(arrow, from, to);
        touched.add(arrow.id);
        changed.add(arrow.id);
        const label = labelOf(arrow);
        if (label) {
          redrawTextBoundingBox(label, arrow, arrayToMap(elements));
          touched.add(label.id);
          changed.add(label.id);
        }
      }
    }
  }

  if (errors.length) {
    return { scene: null, touched: [], issues: [], preexisting: 0, errors };
  }
  // Changed shapes need a newer version than the saved one, so live sync takes them.
  const saved = new Map(
    (base.elements ?? []).map((element) => [element.id, element.version]),
  );
  const now = Date.now();
  for (const element of elements) {
    if (changed.has(element.id) || !saved.has(element.id)) {
      Object.assign(element, {
        version: Math.max(element.version, (saved.get(element.id) ?? 0) + 1),
        versionNonce: randomInteger(),
        updated: now,
      });
    }
  }
  const ordered = syncInvalidIndices(elements);
  const { issues, preexisting } = checkRules(ordered, touched);
  return {
    scene: JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "switchboard-agent",
      elements: ordered,
      appState: base.appState ?? {},
      files: base.files ?? {},
    }),
    touched: [...touched],
    issues,
    preexisting,
    errors,
  };
}

async function loadFonts() {
  await Fonts.loadElementsFonts([
    newTextElement({
      text: "Aa",
      fontFamily: FONT_FAMILY.Excalifont,
      x: 0,
      y: 0,
    }),
  ]);
}

/** The smallest box around shapes; zeros when there are none. */
export function bounds(
  shapes: readonly Box[],
): [number, number, number, number] {
  if (!shapes.length) {
    return [0, 0, 0, 0];
  }
  return [
    Math.min(...shapes.map((s) => s.x)),
    Math.min(...shapes.map((s) => s.y)),
    Math.max(...shapes.map((s) => s.x + s.width)),
    Math.max(...shapes.map((s) => s.y + s.height)),
  ];
}

const overlaps = (a: Box, b: Box, margin = 0) =>
  a.x < b.x + b.width + margin &&
  b.x < a.x + a.width + margin &&
  a.y < b.y + b.height + margin &&
  b.y < a.y + a.height + margin;

const contains = (outer: Box, inner: Box, slack = 1) =>
  inner.x >= outer.x - slack &&
  inner.y >= outer.y - slack &&
  inner.x + inner.width <= outer.x + outer.width + slack &&
  inner.y + inner.height <= outer.y + outer.height + slack;

/**
 * Places new boxes: one connected to an already placed box goes next to it, in the first
 * free spot; the rest are laid out in layers that follow their arrows, to the right of (or
 * below) the drawing. Moves each box together with its label.
 */
function placeBoxes(
  elements: Shape[],
  boxes: Shape[],
  edges: [string, string][],
  direction: "right" | "down",
) {
  const pending = new Set(boxes.map((box) => box.id));
  const placed = () =>
    elements.filter(
      (e) => !e.isDeleted && SOLID_TYPES.has(e.type) && !pending.has(e.id),
    );
  const moveTo = (box: Shape, x: number, y: number) => {
    const label = elements.find(
      (e) => e.type === "text" && e.containerId === box.id,
    );
    if (label) {
      Object.assign(label, { x: label.x + x - box.x, y: label.y + y - box.y });
    }
    Object.assign(box, { x: Math.round(x), y: Math.round(y) });
    pending.delete(box.id);
  };
  // Next to a placed neighbour, while one exists.
  if (placed().length) {
    let progress = true;
    while (progress) {
      progress = false;
      for (const box of boxes.filter((b) => pending.has(b.id))) {
        const neighbour = edges
          .flatMap(([a, b]) => (a === box.id ? [b] : b === box.id ? [a] : []))
          .map((id) => placed().find((p) => p.id === id))
          .find(Boolean);
        if (neighbour) {
          const spot = freeSpot(box, neighbour, placed(), direction);
          moveTo(box, spot.x, spot.y);
          progress = true;
        }
      }
    }
  }
  const rest = boxes.filter((b) => pending.has(b.id));
  if (!rest.length) {
    return;
  }
  const spots = layeredLayout(
    rest.map((b) => ({ id: b.id, width: b.width, height: b.height })),
    edges,
    direction,
  );
  const [, top, right, bottom] = bounds(placed());
  const originX = placed().length && direction === "right" ? right + 200 : 0;
  const originY = placed().length && direction === "down" ? bottom + 200 : top;
  for (const box of rest) {
    const spot = spots.get(box.id)!;
    moveTo(box, originX + spot.x, originY + spot.y);
  }
}

/** The first free place beside `neighbour`: after it in the flow, then across, then before. */
export function freeSpot(
  box: Box,
  neighbour: Box,
  others: readonly Box[],
  direction: "right" | "down",
): { x: number; y: number } {
  const n = neighbour;
  const after =
    direction === "right"
      ? { x: n.x + n.width + GAP.along, y: n.y + (n.height - box.height) / 2 }
      : { x: n.x + (n.width - box.width) / 2, y: n.y + n.height + GAP.along };
  const candidates: { x: number; y: number }[] = [];
  for (let step = 0; step < 6; step++) {
    const offset = step === 0 ? 0 : Math.ceil(step / 2) * (step % 2 ? 1 : -1);
    candidates.push(
      direction === "right"
        ? { x: after.x, y: after.y + offset * (box.height + GAP.across) }
        : { x: after.x + offset * (box.width + GAP.across), y: after.y },
    );
  }
  candidates.push(
    direction === "right"
      ? { x: n.x - box.width - GAP.along, y: after.y }
      : { x: after.x, y: n.y - box.height - GAP.along },
  );
  return (
    candidates.find(
      (spot) =>
        !others.some((other) =>
          overlaps({ ...box, ...spot }, other, GAP.across / 2),
        ),
    ) ?? candidates[0]
  );
}

/**
 * Layers boxes along their arrows: each box one layer after the furthest box pointing at it
 * (loops broken), boxes in a layer ordered by where their neighbours sit, each layer centred.
 * Returns positions relative to the block's top-left.
 */
export function layeredLayout(
  boxes: readonly { id: string; width: number; height: number }[],
  edges: readonly [string, string][],
  direction: "right" | "down",
): Map<string, { x: number; y: number }> {
  const ids = new Set(boxes.map((b) => b.id));
  const links = edges.filter(([a, b]) => ids.has(a) && ids.has(b) && a !== b);
  // Drop arrows that close a loop, in the boxes' given order.
  const forward: [string, string][] = [];
  const state = new Map<string, "open" | "done">();
  const visit = (id: string) => {
    state.set(id, "open");
    for (const edge of links.filter(([a]) => a === id)) {
      const next = state.get(edge[1]);
      if (next === "open") {
        continue;
      }
      forward.push(edge);
      if (!next) {
        visit(edge[1]);
      }
    }
    state.set(id, "done");
  };
  boxes.forEach((b) => !state.has(b.id) && visit(b.id));
  const layer = new Map<string, number>(boxes.map((b) => [b.id, 0]));
  for (let pass = 0; pass < boxes.length; pass++) {
    for (const [a, b] of forward) {
      layer.set(b, Math.max(layer.get(b)!, layer.get(a)! + 1));
    }
  }
  const layers: string[][] = [];
  for (const box of boxes) {
    (layers[layer.get(box.id)!] ??= []).push(box.id);
  }
  const position = new Map<string, number>();
  const reindex = () =>
    layers.forEach((ids) => ids.forEach((id, i) => position.set(id, i)));
  reindex();
  const neighbours = (id: string, before: boolean) =>
    forward
      .filter(([a, b]) => (before ? b === id : a === id))
      .map(([a, b]) => (before ? a : b));
  for (let sweep = 0; sweep < 4; sweep++) {
    const down = sweep % 2 === 0;
    const order = down ? layers : [...layers].reverse();
    for (const ids of order) {
      const centre = (id: string) => {
        const near = neighbours(id, down);
        return near.length
          ? near.reduce((sum, n) => sum + position.get(n)!, 0) / near.length
          : position.get(id)!;
      };
      ids.sort((a, b) => centre(a) - centre(b));
      reindex();
    }
  }
  const size = new Map(boxes.map((b) => [b.id, b]));
  const along = (id: string) =>
    direction === "right" ? size.get(id)!.width : size.get(id)!.height;
  const across = (id: string) =>
    direction === "right" ? size.get(id)!.height : size.get(id)!.width;
  const spans = layers.map(
    (ids) =>
      ids.reduce((sum, id) => sum + across(id), 0) +
      GAP.across * Math.max(ids.length - 1, 0),
  );
  const widest = Math.max(...spans, 0);
  const spots = new Map<string, { x: number; y: number }>();
  let start = 0;
  layers.forEach((ids, index) => {
    const depth = Math.max(...ids.map(along));
    let cursor = (widest - spans[index]) / 2;
    for (const id of ids) {
      const a = start + (depth - along(id)) / 2;
      spots.set(
        id,
        direction === "right" ? { x: a, y: cursor } : { x: cursor, y: a },
      );
      cursor += across(id) + GAP.across;
    }
    start += depth + GAP.along;
  });
  return spots;
}

/** Draws an arrow straight between the edges of two boxes, `ARROW_GAP` away from each. */
function route(arrow: Shape, from: Shape, to: Shape) {
  const start = edgePoint(from, centre(to));
  const end = edgePoint(to, centre(from));
  Object.assign(arrow, {
    x: start.x,
    y: start.y,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
    points: [
      pointFrom<LocalPoint>(0, 0),
      pointFrom<LocalPoint>(end.x - start.x, end.y - start.y),
    ],
  });
}

const centre = (box: Box) => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
});

/** Where the line from a box's centre towards `target` leaves its outline, plus the gap. */
export function edgePoint(
  box: Box & { type?: string },
  target: { x: number; y: number },
) {
  const c = centre(box);
  const dx = target.x - c.x;
  const dy = target.y - c.y;
  const length = Math.hypot(dx, dy) || 1;
  const hw = box.width / 2;
  const hh = box.height / 2;
  let t: number;
  if (box.type === "ellipse") {
    t = 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2);
  } else if (box.type === "diamond") {
    t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  } else {
    t = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
  }
  const gap = ARROW_GAP / length;
  return {
    x: Math.round(c.x + dx * (t + gap)),
    y: Math.round(c.y + dy * (t + gap)),
  };
}

/** Whether the segment p→q crosses the inside of `box` (shrunk a little). */
export function crosses(
  p: { x: number; y: number },
  q: { x: number; y: number },
  box: Box,
  shrink = 4,
) {
  const [x1, y1] = [box.x + shrink, box.y + shrink];
  const [x2, y2] = [box.x + box.width - shrink, box.y + box.height - shrink];
  if (x2 <= x1 || y2 <= y1) {
    return false;
  }
  let [t0, t1] = [0, 1];
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  for (const [pe, qe] of [
    [-dx, p.x - x1],
    [dx, x2 - p.x],
    [-dy, p.y - y1],
    [dy, y2 - p.y],
  ]) {
    if (pe === 0) {
      if (qe < 0) {
        return false;
      }
    } else {
      const r = qe / pe;
      if (pe < 0) {
        t0 = Math.max(t0, r);
      } else {
        t1 = Math.min(t1, r);
      }
    }
  }
  return t0 < t1;
}

/**
 * The rules every agent change must pass, for shapes it touched: arrows connected at both
 * ends, no partly overlapping boxes (a box drawn around others is fine), labels inside their
 * boxes, no box stranded far from the rest, and no arrow running through another box.
 */
export function checkRules(
  elements: readonly Shape[],
  touched: ReadonlySet<string>,
): { issues: Issue[]; preexisting: number } {
  const live = elements.filter((e) => !e.isDeleted);
  const map = new Map(live.map((e) => [e.id, e]));
  const nameOf = (e: Shape) => {
    const label = live.find((t) => t.type === "text" && t.containerId === e.id);
    const text =
      label && label.type === "text"
        ? label.text
        : e.type === "text"
        ? e.text
        : "";
    return text ? `"${text.replace(/\s+/g, " ")}"` : e.id;
  };
  const issues: Issue[] = [];
  let preexisting = 0;
  const report = (mine: boolean, issue: Issue) =>
    mine ? issues.push(issue) : preexisting++;
  const solids = live.filter((e) => SOLID_TYPES.has(e.type));
  const arrows = live.filter((e) => e.type === "arrow");

  for (const arrow of arrows) {
    if (arrow.type !== "arrow") {
      continue;
    }
    const start = arrow.startBinding && map.get(arrow.startBinding.elementId);
    const end = arrow.endBinding && map.get(arrow.endBinding.elementId);
    const mine =
      touched.has(arrow.id) || [start, end].some((e) => e && touched.has(e.id));
    if (!start || !end) {
      report(mine, {
        rule: "arrow-connected",
        shapes: [arrow.id],
        message: `Arrow ${arrow.id} is not connected at its ${
          !start ? "start" : "end"
        }`,
      });
      continue;
    }
    const first = arrow.points[0];
    const last = arrow.points[arrow.points.length - 1];
    const p = { x: arrow.x + first[0], y: arrow.y + first[1] };
    const q = { x: arrow.x + last[0], y: arrow.y + last[1] };
    for (const box of solids) {
      if (
        box.id === start.id ||
        box.id === end.id ||
        (contains(box, start) && contains(box, end))
      ) {
        continue;
      }
      if (crosses(p, q, box)) {
        report(mine || touched.has(box.id), {
          rule: "runs-through",
          shapes: [arrow.id, box.id],
          message: `The arrow from ${nameOf(start)} to ${nameOf(
            end,
          )} runs through ${nameOf(box)}`,
        });
      }
    }
  }

  // A box drawn around others groups them: it is much bigger, and its label stays clear.
  const groups = (outer: Shape, inner: Shape) => {
    const label = live.find(
      (t) => t.type === "text" && t.containerId === outer.id,
    );
    return (
      contains(outer, inner) &&
      outer.width * outer.height >= 2.5 * inner.width * inner.height &&
      !(label && overlaps(label, inner))
    );
  };
  for (let i = 0; i < solids.length; i++) {
    for (let j = i + 1; j < solids.length; j++) {
      const [a, b] = [solids[i], solids[j]];
      if (overlaps(a, b) && !groups(a, b) && !groups(b, a)) {
        report(touched.has(a.id) || touched.has(b.id), {
          rule: "overlap",
          shapes: [a.id, b.id],
          message: `${nameOf(a)} and ${nameOf(b)} overlap`,
        });
      }
    }
  }

  for (const text of live) {
    if (text.type !== "text" || !text.containerId) {
      continue;
    }
    const container = map.get(text.containerId);
    if (
      !container ||
      container.type === "arrow" ||
      !SOLID_TYPES.has(container.type)
    ) {
      continue;
    }
    if (!contains(container, text, 2)) {
      report(touched.has(text.id) || touched.has(container.id), {
        rule: "text-fits",
        shapes: [container.id],
        message: `The label of ${nameOf(container)} does not fit its box`,
      });
    }
  }

  if (solids.length > 1) {
    for (const box of solids) {
      if (
        !touched.has(box.id) ||
        arrows.some(
          (a) =>
            a.type === "arrow" &&
            (a.startBinding?.elementId === box.id ||
              a.endBinding?.elementId === box.id),
        )
      ) {
        continue;
      }
      const gap = Math.min(
        ...solids
          .filter((other) => other.id !== box.id)
          .map((other) =>
            Math.hypot(
              Math.max(
                other.x - (box.x + box.width),
                box.x - (other.x + other.width),
                0,
              ),
              Math.max(
                other.y - (box.y + box.height),
                box.y - (other.y + other.height),
                0,
              ),
            ),
          ),
      );
      if (gap > STRANDED) {
        issues.push({
          rule: "stranded",
          shapes: [box.id],
          message: `${nameOf(
            box,
          )} is far from everything else and has no arrows`,
        });
      }
    }
  }
  return { issues, preexisting };
}
