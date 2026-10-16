import type { AppState } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

/** How long the selection has to stay put before it is reported. */
export const SELECTION_SETTLE_MS = 400;

/**
 * The shapes Arun has selected, as the diagram agent names them: a box's label counts as
 * its box, deleted shapes not at all. Sorted, so the same selection always reads the same.
 */
export function selectedShapes(
  elements: readonly ExcalidrawElement[],
  selected: AppState["selectedElementIds"],
): string[] {
  const shapes = new Set<string>();
  for (const element of elements) {
    if (element.isDeleted || !selected[element.id]) {
      continue;
    }
    const container = element.type === "text" ? element.containerId : undefined;
    shapes.add(container ?? element.id);
  }
  return [...shapes].sort();
}

/**
 * Reports the selection once it settles, and only when it changed. The first one is always
 * reported, so opening a diagram replaces whatever a closed window left selected.
 */
export class SelectionReporter {
  private reported: string | null = null;
  private pending: string[] | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly report: (shapes: string[]) => void,
    private readonly settleMs = SELECTION_SETTLE_MS,
  ) {}

  update(
    elements: readonly ExcalidrawElement[],
    appState: Pick<AppState, "selectedElementIds">,
  ) {
    const shapes = selectedShapes(elements, appState.selectedElementIds);
    const key = shapes.join("\n");
    if (key === (this.pending?.join("\n") ?? this.reported)) {
      return;
    }
    clearTimeout(this.timer);
    this.pending = shapes;
    this.timer = setTimeout(() => {
      const settled = this.pending;
      this.pending = null;
      if (settled && settled.join("\n") !== this.reported) {
        this.reported = settled.join("\n");
        this.report(settled);
      }
    }, this.settleMs);
  }
}
