import { exportToCanvas } from "@excalidraw/excalidraw";

import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

/** One diagram drawn as PNG data URLs, in Excalidraw's light and dark looks. */
export type Pictures = { light: string; dark: string };

/** Pictures are drawn at 2x, and never wider or taller than this many pixels. */
const DEFAULT_MAX_SIZE = 1200;
const PADDING = 16;
const EMPTY_SIZE = { width: 400, height: 250 };

/**
 * Draws a saved scene the way Excalidraw exports it: the drawing only, on the diagram's
 * background. Jarvis's Renderer opens the studio with `?render=1` and calls this, so list
 * pictures come from the same code the editor uses. The dark picture is the light one in the
 * editor's dark look (see `darkened`).
 */
export async function renderPictures(
  scene: string,
  maxSize = DEFAULT_MAX_SIZE,
): Promise<Pictures> {
  const parsed = JSON.parse(scene) as {
    elements?: ExcalidrawElement[];
    appState?: Partial<AppState>;
    files?: BinaryFiles;
  };
  const elements = (parsed.elements ?? []).filter((e) => !e.isDeleted);
  const light =
    elements.length === 0
      ? emptyPicture(parsed.appState?.viewBackgroundColor ?? "#ffffff")
      : await exportToCanvas({
          elements,
          files: parsed.files ?? {},
          appState: {
            ...parsed.appState,
            exportBackground: true,
            exportWithDarkMode: false,
          },
          exportPadding: PADDING,
          getDimensions: (width, height) => {
            const scale = Math.min(2, maxSize / Math.max(width, height, 1));
            return {
              width: Math.round(width * scale),
              height: Math.round(height * scale),
              scale,
            };
          },
        });
  return {
    light: light.toDataURL("image/png"),
    dark: darkened(light).toDataURL("image/png"),
  };
}

/** A blank page in the diagram's background, so an emptied diagram still has a picture. */
function emptyPicture(background: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = EMPTY_SIZE.width;
  canvas.height = EMPTY_SIZE.height;
  const context = canvas.getContext("2d")!;
  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Excalidraw's dark look: the CSS filter `invert(93%) hue-rotate(180deg)` that the editor puts
 * on its canvas, worked out in sRGB as WebKit applies it (measured within 2 of 255 levels).
 * Excalidraw's own dark export sets the same filter on the canvas context, which WebKit
 * ignores, so it is computed here. Pictures inside a diagram are inverted too, as the app
 * shows them in dark mode.
 */
function darkened(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext("2d")!;
  context.drawImage(source, 0, 0);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = image.data; // clamps and rounds on assignment
  for (let i = 0; i < pixels.length; i += 4) {
    const r = 237.15 - 0.86 * pixels[i];
    const g = 237.15 - 0.86 * pixels[i + 1];
    const b = 237.15 - 0.86 * pixels[i + 2];
    pixels[i] = -0.574 * r + 1.43 * g + 0.144 * b;
    pixels[i + 1] = 0.426 * r + 0.43 * g + 0.144 * b;
    pixels[i + 2] = 0.426 * r + 1.43 * g - 0.856 * b;
  }
  context.putImageData(image, 0, 0);
  return canvas;
}
