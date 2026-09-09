import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'es2022',
  dts: true,
  sourcemap: false,
  clean: true,
  outDir: 'lib',
  // ⚠️ 关闭 tree-shake:rollup 曾误删 compliance.ts 的 asAppliedRecord 导出,
  // 导致运行时 ReferenceError(插件 bundle 无需激进摇树,保留全部产物更稳)
  treeshake: false,
  // Runtime @deepseek-ai/* resolution falls back to the global dsh install
  // (~/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/*).
  external: [/^@deepseek-ai\//, /^node:/],
  platform: 'node',
});