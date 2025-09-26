import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    host: true, // listen on 0.0.0.0 so the tunnel can reach Vite
    allowedHosts: ['2c7d4e0c2fe1.ngrok-free.app'],
    // If HMR struggles through the tunnel, try:
    // hmr: { host: '2fdbc2d26433.ngrok-free.app', protocol: 'wss', clientPort: 443 }
  },
})