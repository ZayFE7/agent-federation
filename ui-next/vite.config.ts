import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    target: "es2020",
    chunkSizeWarningLimit: 700,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  server: { host: "127.0.0.1" },
});
