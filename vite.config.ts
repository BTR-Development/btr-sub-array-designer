import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // port comes from the PORT env var when the harness assigns one
    port: process.env.PORT ? Number(process.env.PORT) : 5180,
  },
});
