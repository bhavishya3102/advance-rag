import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_TARGET = process.env.VITE_API_TARGET ?? "http://127.0.0.1:8000";

// In dev the app is served by Vite on :5173 and /api is proxied to the Express
// API, so the browser only ever talks to one origin and CORS never applies.
// In production `npm run build` emits web/dist, which Express serves itself.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
