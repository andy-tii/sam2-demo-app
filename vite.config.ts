import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // 0.0.0.0 so ngrok can reach it
    allowedHosts: ["08877f059ff7.ngrok-free.app"],

    proxy: {
      "/click": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
      "/preview": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },

    // If HMR doesn’t work over ngrok, uncomment:
    // hmr: { host: "08877f059ff7.ngrok-free.app", protocol: "wss", clientPort: 443 },
  },
});
