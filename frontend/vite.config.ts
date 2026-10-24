import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  plugins: [react(), tailwindcss()],
  // AudioWorklet modules must load from a real URL; data: URLs fail in some browsers.
  build: { assetsInlineLimit: (file) => (file.endsWith(".js") ? false : undefined) },
});
