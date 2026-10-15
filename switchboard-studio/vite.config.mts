import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Switchboard Studio build: one self-contained folder (index.html, assets/, fonts/) that the
// gateway serves and the apps keep. No CDN, no service worker, no excalidraw.com services.
export default defineConfig({
  base: "./",
  envDir: "../",
  server: { port: 5180 },
  resolve: {
    alias: [
      { find: /^@excalidraw\/excalidraw$/, replacement: path.resolve(__dirname, "../packages/excalidraw/index.tsx") },
      { find: /^@excalidraw\/excalidraw\/(.*?)/, replacement: path.resolve(__dirname, "../packages/excalidraw/$1") },
      { find: /^@excalidraw\/utils$/, replacement: path.resolve(__dirname, "../packages/utils/index.ts") },
      { find: /^@excalidraw\/utils\/(.*?)/, replacement: path.resolve(__dirname, "../packages/utils/$1") },
      { find: /^@excalidraw\/math$/, replacement: path.resolve(__dirname, "../packages/math/index.ts") },
      { find: /^@excalidraw\/math\/(.*?)/, replacement: path.resolve(__dirname, "../packages/math/$1") },
    ],
  },
  build: {
    outDir: "build",
    assetsInlineLimit: 0,
    sourcemap: false,
    rollupOptions: {
      output: {
        assetFileNames(chunkInfo) {
          if (chunkInfo?.name?.endsWith(".woff2")) {
            const family = chunkInfo.name.split("-")[0];
            return `fonts/${family}/[name][extname]`;
          }
          return "assets/[name]-[hash][extname]";
        },
        manualChunks(id) {
          if (id.includes("packages/excalidraw/locales") && id.match(/en.json|percentages.json/) === null) {
            const index = id.indexOf("locales/");
            return `locales/${id.substring(index + 8)}`;
          }
        },
      },
    },
  },
  plugins: [react()],
});
