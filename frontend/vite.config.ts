import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** GitHub Pages has no SPA fallback. `/setup/` needs its own index. */
function setupPage(): Plugin {
  return {
    name: "setup-page",
    apply: "build",
    closeBundle() {
      const dist = join(dirname(fileURLToPath(import.meta.url)), "dist");
      const html = readFileSync(join(dist, "index.html"));
      const setup = join(dist, "setup");
      mkdirSync(setup, { recursive: true });
      writeFileSync(join(setup, "index.html"), html);
    },
  };
}

export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  plugins: [react(), tailwindcss(), setupPage()],
  // AudioWorklet modules must load from a real URL; data: URLs fail in some browsers.
  build: { assetsInlineLimit: (file) => (file.endsWith(".js") ? false : undefined) },
});
