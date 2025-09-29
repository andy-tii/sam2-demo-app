import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // 0.0.0.0 so ngrok can reach it
    allowedHosts: ["e2227d75fdc1.ngrok-free.app","6bc63facb388.ngrok-free.app", "d5fc7657cffb.ngrok-free.app"],

    proxy: {
    "/click":   { target: "http://localhost:8000", changeOrigin: true },
    "/preview": { target: "http://localhost:8000", changeOrigin: true },
    "/save":    { target: "http://localhost:8000", changeOrigin: true },
    "/masks":   { target: "http://localhost:8000", changeOrigin: true },  // <- added
    "/delete":  { target: "http://localhost:8000", changeOrigin: true },  // <- added
    "/log":   { target: "http://localhost:8000", changeOrigin: true },  // <- added
    "/status":  { target: "http://localhost:8000", changeOrigin: true },  // <- added
  }
  },
});
