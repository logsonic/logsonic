import path from "path";

import react from "@vitejs/plugin-react-swc";
import { visualizer } from "rollup-plugin-visualizer";
import { defineConfig } from "vite";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: process.env['PORT'] ? Number(process.env['PORT']) : 8080,
  },
  plugins: [
    react(),
    mode === 'analyze' && visualizer({
      open: true,
      filename: 'dist/stats.html',
      gzipSize: true,
      brotliSize: true,
    }),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@/shared": path.resolve(__dirname, "./src/shared"),
      "@/features": path.resolve(__dirname, "./src/features"),
      "@/components": path.resolve(__dirname, "./src/components"),
    },
  },
  build: {
    target: 'es2015',
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: mode === 'production',
        drop_debugger: mode === 'production',
      },
    },
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'ui-vendor': [
            '@radix-ui/react-tooltip',
            '@radix-ui/react-dialog',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-label',
            '@radix-ui/react-slot',
            '@radix-ui/react-separator',
            '@radix-ui/react-scroll-area',
            '@radix-ui/react-popover',
            '@radix-ui/react-navigation-menu',
            '@radix-ui/react-menubar',
            '@radix-ui/react-hover-card',
            '@radix-ui/react-checkbox',
            '@radix-ui/react-collapsible',
            '@radix-ui/react-context-menu',
            '@radix-ui/react-aspect-ratio',
            '@radix-ui/react-avatar',
            '@radix-ui/react-accordion',
            '@radix-ui/react-alert-dialog',
            '@radix-ui/react-progress',
            '@radix-ui/react-radio-group',
            '@radix-ui/react-select',
            '@radix-ui/react-slider',
            '@radix-ui/react-switch',
            '@radix-ui/react-tabs',
            '@radix-ui/react-toast',
            '@radix-ui/react-toggle',
            '@radix-ui/react-toggle-group',
            'react-resizable-panels',
            'react-day-picker',
            'cmdk',
            'class-variance-authority',
            'clsx',
            'tailwind-merge',
            'tailwindcss-animate',
            'next-themes',
            'sonner',
            'vaul',
            'input-otp',
            'react-timezone-select',
            'timezone-support'
          ],
          'chart-vendor': ['recharts'],
          'form-vendor': ['react-hook-form', 'zod', '@hookform/resolvers'],
          'date-vendor': ['date-fns', 'date-fns-tz'],
          'dnd-vendor': ['@dnd-kit/core', '@dnd-kit/modifiers', '@dnd-kit/sortable', '@dnd-kit/utilities'],
          'icons': ['lucide-react'],
          'utils': ['lodash']
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]'
      },
    },
  },
}));
