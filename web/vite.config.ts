import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: ['admin.localhost'],
    proxy: {
      '/api': { target: 'http://localhost:3001', rewrite: path => path.replace(/^\/api/, '') }
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/maplibre-gl/')) return 'maplibre'
        },
      },
    },
  }
})
