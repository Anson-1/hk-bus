import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import http from 'http'

// Fresh agent bypasses any system proxy (e.g. Clash) for localhost Docker calls
const directAgent = new http.Agent()

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/api': { target: 'http://localhost:3000', agent: directAgent },
      '/socket.io': { target: 'http://localhost:3000', ws: true, agent: directAgent },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false
  }
})
