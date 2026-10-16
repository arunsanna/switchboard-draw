import { afterEach, describe, expect, it, vi } from "vitest";

import { PROPOSAL_KEY, pendingProposals } from "./proposals";
import {
  gatewayTransport,
  nativeBridgeProtocol,
  nativeTransport,
} from "./sync";

import type { NativeBridge } from "./sync";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

const shape = (
  id: string,
  mark?: { id: string; summary: string; at: number },
  deleted = false,
) =>
  ({
    id,
    type: "rectangle",
    isDeleted: deleted,
    customData: mark ? { [PROPOSAL_KEY]: mark } : undefined,
  } as unknown as ExcalidrawElement);

describe("proposals on the board", () => {
  it("are read from the marks on their shapes, newest first", () => {
    const first = { id: "p1", summary: "Added a cache", at: 10 };
    const second = { id: "p2", summary: "Made it red", at: 20 };
    const found = pendingProposals([
      shape("api"),
      shape("cache", first),
      shape("cache-arrow", first),
      shape("cache-label", second),
      shape("gone", first, true),
    ]);
    expect(
      found.map((p) => [p.id, p.summary, p.shapes.map((s) => s.id)]),
    ).toEqual([
      ["p2", "Made it red", ["cache-label"]],
      ["p1", "Added a cache", ["cache", "cache-arrow"]],
    ]);
    expect(pendingProposals([shape("api")])).toEqual([]);
  });
});

describe("keep and undo", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("go to the gateway from a browser copy", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    expect(await gatewayTransport("d 1").decide!("p1", "keep")).toEqual({
      ok: true,
    });
    expect(fetch).toHaveBeenCalledWith(
      "../api/diagrams/d%201/proposals/p1/keep",
      { method: "POST" },
    );
    fetch.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({ error: "This proposal was already kept" }),
          { status: 409 },
        ),
    );
    expect(await gatewayTransport("d1").decide!("p1", "undo")).toEqual({
      ok: false,
      message: "This proposal was already kept",
    });
  });

  it("go through the app only when it speaks protocol 3", async () => {
    const messages: unknown[] = [];
    const bridge: NativeBridge = {
      postMessage: async (message) => {
        messages.push(message);
        return (message as { type: string }).type === "hello"
          ? { protocol: 3 }
          : { ok: true };
      },
    };
    expect(await nativeBridgeProtocol(bridge)).toBe(3);
    expect(await nativeTransport(bridge, 3).decide!("p1", "undo")).toEqual({
      ok: true,
    });
    expect(messages.at(-1)).toEqual({
      type: "proposal",
      proposal: "p1",
      action: "undo",
    });
    expect(nativeTransport(bridge, 2).decide).toBeUndefined();
    const silent: NativeBridge = { postMessage: async () => undefined };
    expect(await nativeBridgeProtocol(silent)).toBe(0);
  });
});
