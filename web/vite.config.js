import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// El build queda en web/dist: el servidor sirve index.html en "/" y el resto
// bajo "/static". En desarrollo (npm run dev) la API y el WebSocket van al
// backend en 8787.
const BACKEND = "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/static/",
  server: {
    port: 5173,
    proxy: {
      "/api": BACKEND,
      "/ws": { target: BACKEND, ws: true },
    },
  },
});
