import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { pdfReportsPlugin } from './vite/pdfReportsPlugin';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const reportsDir = env.REPORTS_DIR || process.env.REPORTS_DIR || '';

  return {
    plugins: [react(), pdfReportsPlugin(reportsDir)],
    server: {
      port: 5174,
      host: true,
      proxy: {
        '/api/opencode-go': {
          target: 'https://opencode.ai/zen/go',
          changeOrigin: true,
          rewrite: path => path.replace(/^\/api\/opencode-go/, ''),
        },
      },
    },
  };
});
