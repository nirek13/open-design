import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Listed before the module alias: Vite matches string aliases by prefix,
      // so the bare '@excalidraw/excalidraw' entry would otherwise swallow the
      // stylesheet path and try to parse a component as CSS.
      '@excalidraw/excalidraw/index.css': resolve(__dirname, 'tests/helpers/excalidraw-mock.css'),
      '@excalidraw/excalidraw': resolve(__dirname, 'tests/helpers/excalidraw-mock.tsx'),
      'motion/react': resolve(__dirname, 'tests/helpers/motion-mock.tsx'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['./tests/setup/jsdom-lexical.ts'],
  },
});
