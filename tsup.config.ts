import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'es2022',
  dts: true,
  sourcemap: false,
  clean: true,
  outDir: 'lib',
  // Runtime @deepseek-ai/* resolution falls back to the global dsh install
  // (~/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/*).
  external: [/^@deepseek-ai\//, /^node:/],
  platform: 'node',
});