import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const FORBIDDEN_SECRET_PATTERNS = [
  'DATABASE_URL',
  'GEMINI_API_KEY',
  'CLAIRFLUX_ACCESS_SECRET_HASH',
  'CLAIRFLUX_SESSION_SECRET',
  'INTERNAL_WORKER_TOKEN',
  'PRIVATE_KEY',
  'GOOGLE_DRIVE',
  'SERVICE_ACCOUNT',
] as const;

/**
 * Empêche toute exposition accidentelle de variables serveur sensibles
 * dans le bundle client Web ou APK Capacitor via préfixe VITE_.
 */
function guardNoServerSecretsPlugin(mode: string): Plugin {
  return {
    name: 'clairflux-guard-no-server-secrets',
    configResolved() {
      const viteEnv = loadEnv(mode, process.cwd(), 'VITE_');
      for (const key of Object.keys(viteEnv)) {
        const upperKey = key.toUpperCase();
        for (const forbidden of FORBIDDEN_SECRET_PATTERNS) {
          if (upperKey.includes(forbidden)) {
            throw new Error(
              `[ClairFlux Security] Variable serveur interdite détectée dans le périmètre client VITE_ : ${key}`,
            );
          }
        }
      }
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), guardNoServerSecretsPlugin(mode)],
  envPrefix: ['VITE_'],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: ['es2022', 'chrome114', 'safari16'],
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id: string): string | undefined {
          if (
            id.includes('/node_modules/react/') ||
            id.includes('/node_modules/react-dom/') ||
            id.includes('/node_modules/scheduler/') ||
            id.includes('\\node_modules\\react\\') ||
            id.includes('\\node_modules\\react-dom\\') ||
            id.includes('\\node_modules\\scheduler\\')
          ) {
            return 'vendor-react';
          }
          if (
            id.includes('/node_modules/d3-') ||
            id.includes('/node_modules/victory-vendor/') ||
            id.includes('\\node_modules\\d3-') ||
            id.includes('\\node_modules\\victory-vendor\\')
          ) {
            return 'vendor-d3';
          }
          if (
            id.includes('/node_modules/recharts/') ||
            id.includes('\\node_modules\\recharts\\')
          ) {
            return 'vendor-recharts';
          }
          return undefined;
        },
      },
    },
  },
}));
