import { afterEach, describe, expect, it, vi } from "vitest";

import { SelectionReporter, selectedShapes } from "./selection";
import { gatewayTransport, nativeTransport } from "./sync";

import type { NativeBridge } from "./sync";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

const shape = (
  id: string,
  extra: Partial<{
    type: string;
    containerId: string;
    isDeleted: boolean;
  }> = {},
) =>
  ({
    id,
    type: "rectangle",
    isDeleted: false,
    ...extra,
  } as unknown as ExcalidrawElement);

const board = [
  shape("db"),
  shape("db-label", { type: "text", containerId: "db" }),
  shape("api"),
  shape("title", { type: "text" }),
  shape("gone", { isDeleted: true }),
];

const picked = (...ids: string[]) =>
  Object.fromEntries(ids.map((id) => [id, true as const]));

describe("the selection the agent sees", () => {
  it("names a box for its label, skips deleted shapes and sorts", () => {
    expect(
      selectedShapes(board, picked("db-label", "title", "gone", "api", "db")),
    ).toEqual(["api", "db", "title"]);
  });

  describe("reporting", () => {
    afterEach(() => vi.useRealTimers());

    it("reports the first selection, even an empty one", () => {
      vi.useFakeTimers();
      const report = vi.fn();
      new SelectionReporter(report, 400).update(board, {
        selectedElementIds: {},
      });
      vi.advanceTimersByTime(400);
      expect(report).toHaveBeenCalledWith([]);
    });

    it("waits for the selection to settle and reports only changes", () => {
      vi.useFakeTimers();
      const report = vi.fn();
      const reporter = new SelectionReporter(report, 400);
      reporter.update(board, { selectedElementIds: picked("api") });
      reporter.update(board, { selectedElementIds: picked("db") });
      vi.advanceTimersByTime(399);
      expect(report).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(report).toHaveBeenCalledWith(["db"]);

      reporter.update(board, { selectedElementIds: picked("db-label") });
      vi.advanceTimersByTime(1000);
      expect(report).toHaveBeenCalledTimes(1);

      reporter.update(board, { selectedElementIds: {} });
      vi.advanceTimersByTime(400);
      expect(report).toHaveBeenLastCalledWith([]);
    });

    it("drops a selection that went back before it settled", () => {
      vi.useFakeTimers();
      const report = vi.fn();
      const reporter = new SelectionReporter(report, 400);
      reporter.update(board, { selectedElementIds: {} });
      vi.advanceTimersByTime(400);
      reporter.update(board, { selectedElementIds: picked("api") });
      reporter.update(board, { selectedElementIds: {} });
      vi.advanceTimersByTime(400);
      expect(report).toHaveBeenCalledTimes(1);
    });
  });

  it("goes to the app from protocol 4 and to the gateway in a browser", async () => {
    const posted: unknown[] = [];
    const bridge: NativeBridge = { postMessage: (m) => posted.push(m) };
    expect(nativeTransport(bridge, 3).select).toBeUndefined();
    nativeTransport(bridge, 4).select!(["api"]);
    expect(posted).toEqual([{ type: "selection", shapes: ["api"] }]);

    const fetched = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetched);
    try {
      gatewayTransport("d 1").select!(["db"]);
      expect(fetched).toHaveBeenCalledWith("../api/diagrams/d%201/selection", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: '{"shapes":["db"]}',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
