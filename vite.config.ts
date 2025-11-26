import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Proxy /api requests to our Express server
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
      },
       '/uploads': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
      }
    },
  },
  optimizeDeps: {
    exclude: [
      'react',
      'react-dom/client',
      'react/',
      'react-dom/',
      'pdf-lib',
      '@azure/msal-browser',
      '@google/genai'
    ]
  }
});
