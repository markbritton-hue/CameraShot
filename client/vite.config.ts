import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // GitHub Pages serves the site from /CameraShot/; the workflow sets this, local dev and the Node server use /
  base: process.env.GITHUB_PAGES ? '/CameraShot/' : '/',
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': 'http://localhost:3001',
      // live video: the server passes go2rtc's player and video websocket through here
      '/video': { target: 'http://localhost:3001', ws: true },
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
})
