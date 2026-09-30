import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  server: {
    port: Number(process.env.CARL_UI_PORT || 5173),
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${process.env.CARL_PORT || 4317}`,
      "/projects": `http://127.0.0.1:${process.env.CARL_PORT || 4317}`,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          dockview: ["dockview-react"],
          editor: [
            "@uiw/react-codemirror",
            "@codemirror/lang-python",
            "@codemirror/legacy-modes/mode/r",
          ],
        },
      },
    },
  },
});
