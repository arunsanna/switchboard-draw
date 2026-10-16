import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import { getElementBounds } from "@excalidraw/excalidraw/element/bounds";
import {
  arrayToMap,
  sceneCoordsToViewportCoords,
} from "@excalidraw/excalidraw/utils";

import type { AppState } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

import type { Decision } from "./sync";

/** The mark the gateway puts on a proposal's shapes (see the gateway's diagram_proposals.rs). */
export const PROPOSAL_KEY = "switchboardProposal";

export type Proposal = {
  id: string;
  summary: string;
  at: number;
  shapes: ExcalidrawElement[];
};

type Box = {
  key: string;
  left: number;
  top: number;
  width: number;
  height: number;
};

/** Proposals waiting on the board, newest first, read from the marks on their shapes. */
export function pendingProposals(
  elements: readonly ExcalidrawElement[],
): Proposal[] {
  const found = new Map<string, Proposal>();
  for (const element of elements) {
    const mark = element.customData?.[PROPOSAL_KEY] as
      | { id?: string; summary?: string; at?: number }
      | undefined;
    if (element.isDeleted || !mark?.id) {
      continue;
    }
    const proposal = found.get(mark.id) ?? {
      id: mark.id,
      summary: mark.summary ?? "",
      at: mark.at ?? 0,
      shapes: [],
    };
    proposal.shapes.push(element);
    found.set(mark.id, proposal);
  }
  return [...found.values()].sort((a, b) => b.at - a.at);
}

export type ProposalLayerHandle = {
  /** Called with every scene or view change; redraws at most once a frame. */
  update(elements: readonly ExcalidrawElement[], appState: AppState): void;
};

const PALETTE = {
  light: {
    bar: "#ffffff",
    text: "#1b1b1f",
    line: "#e0dfff",
    accent: "#6965db",
  },
  dark: { bar: "#232329", text: "#e3e3e8", line: "#3d3d4d", accent: "#a8a5ff" },
};

/**
 * The agent's proposals on the board: a soft outline around each proposed shape, and for the
 * newest one a bar with its summary, Keep and Undo. Both follow scrolling and zooming. Keep
 * and Undo go to the gateway through `decide`; the board changes when the new version arrives
 * on every open copy. Without `decide` (an older Mac app) the bar says to update.
 */
export const ProposalLayer = forwardRef<
  ProposalLayerHandle,
  {
    theme: "light" | "dark";
    decide?: (proposal: string, action: "keep" | "undo") => Promise<Decision>;
    /** Pull the newest version right after a decision. */
    decided?: () => void;
  }
>(({ theme, decide, decided }, ref) => {
  const [view, setView] = useState<{
    proposals: Proposal[];
    boxes: Box[];
  } | null>(null);
  const [busy, setBusy] = useState<{
    id: string;
    action: "keep" | "undo";
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef<{
    elements: readonly ExcalidrawElement[];
    appState: AppState;
  } | null>(null);
  // Redraws on the next animation frame, or after a short timer when the page is hidden and
  // WebKit sends no frames (a window behind others, a sleeping display).
  const scheduled = useRef<{
    frame: number;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  useImperativeHandle(ref, () => ({
    update(elements, appState) {
      latest.current = { elements, appState };
      if (scheduled.current) {
        return;
      }
      const redraw = () => {
        if (!scheduled.current) {
          return;
        }
        cancelAnimationFrame(scheduled.current.frame);
        clearTimeout(scheduled.current.timer);
        scheduled.current = null;
        const { elements: shapes, appState: state } = latest.current!;
        const proposals = pendingProposals(shapes);
        if (!proposals.length) {
          setView((current) => (current === null ? current : null));
          return;
        }
        const map = arrayToMap(shapes);
        const boxes = proposals.flatMap((proposal) =>
          proposal.shapes
            .filter((shape) => shape.type !== "text" || !shape.containerId)
            .map((shape) => {
              const [x1, y1, x2, y2] = getElementBounds(shape, map);
              const a = sceneCoordsToViewportCoords(
                { sceneX: x1, sceneY: y1 },
                state,
              );
              const b = sceneCoordsToViewportCoords(
                { sceneX: x2, sceneY: y2 },
                state,
              );
              return {
                key: shape.id,
                left: a.x - 6,
                top: a.y - 6,
                width: b.x - a.x + 12,
                height: b.y - a.y + 12,
              };
            }),
        );
        setView({ proposals, boxes });
      };
      scheduled.current = {
        frame: requestAnimationFrame(redraw),
        timer: setTimeout(redraw, 60),
      };
    },
  }));

  // A decision is done when its proposal leaves the board.
  useEffect(() => {
    if (busy && !view?.proposals.some((p) => p.id === busy.id)) {
      setBusy(null);
    }
  }, [busy, view]);

  if (!view) {
    return null;
  }
  const newest = view.proposals[0];
  const colors = PALETTE[theme];
  const act = async (action: "keep" | "undo") => {
    if (!decide) {
      return;
    }
    setBusy({ id: newest.id, action });
    setError(null);
    const answer = await decide(newest.id, action).catch(
      (failure: Error): Decision => ({ ok: false, message: failure.message }),
    );
    if (answer.ok) {
      decided?.();
    } else {
      setBusy(null);
      setError(answer.message);
    }
  };
  const button = (primary: boolean) => ({
    font: "inherit",
    padding: "6px 14px",
    borderRadius: 8,
    border: `1px solid ${primary ? colors.accent : colors.line}`,
    background: primary ? colors.accent : "transparent",
    color: primary ? colors.bar : colors.text,
    cursor: busy ? "default" : "pointer",
    opacity: busy ? 0.6 : 1,
  });
  return (
    <>
      {view.boxes.map((box) => (
        <div
          key={box.key}
          className="sb-proposal-box"
          style={{
            position: "fixed",
            pointerEvents: "none",
            zIndex: 3,
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height,
            borderRadius: 10,
            border: `2px dashed ${colors.accent}`,
            background: `${colors.accent}1a`,
            boxShadow: `0 0 14px ${colors.accent}55`,
          }}
        />
      ))}
      <div
        className="sb-proposal-bar"
        role="status"
        style={{
          position: "fixed",
          left: "50%",
          bottom: 20,
          transform: "translateX(-50%)",
          zIndex: 10,
          display: "flex",
          alignItems: "center",
          gap: 10,
          maxWidth: "min(720px, calc(100vw - 32px))",
          padding: "8px 10px 8px 14px",
          borderRadius: 12,
          background: colors.bar,
          color: colors.text,
          border: `1px solid ${colors.line}`,
          boxShadow: "0 6px 24px rgba(0, 0, 0, 0.18)",
          font: "14px/1.3 system-ui, -apple-system, sans-serif",
        }}
      >
        <span style={{ color: colors.accent, fontWeight: 600 }}>Proposed</span>
        <span
          className="sb-proposal-summary"
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {newest.summary || "A change from the agent"}
          {view.proposals.length > 1
            ? ` (+${view.proposals.length - 1} more)`
            : ""}
        </span>
        {error && <span style={{ color: "#e03131" }}>{error}</span>}
        {decide ? (
          <>
            <button
              className="sb-proposal-keep"
              style={button(true)}
              disabled={!!busy}
              onClick={() => act("keep")}
            >
              {busy?.action === "keep" ? "Keeping…" : "Keep"}
            </button>
            <button
              className="sb-proposal-undo"
              style={button(false)}
              disabled={!!busy}
              onClick={() => act("undo")}
            >
              {busy?.action === "undo" ? "Undoing…" : "Undo"}
            </button>
          </>
        ) : (
          <span style={{ opacity: 0.7 }}>
            Update Switchboard to keep or undo it
          </span>
        )}
      </div>
    </>
  );
});
