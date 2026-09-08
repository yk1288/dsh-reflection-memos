/**
 * 兼容重导出(v5.0 redesign:M0 迁移期双轨)
 *
 * v3.2 的 memos/client.ts 已迁移至 backends/memos-backend.ts(逻辑零变化)。
 * 本文件仅重导出,保证旧导入路径 `../memos/client` 继续可用,
 * 避免 M0 阶段一次性大改所有模块(迁移纪律 #2)。
 */
export * from '../backends/memos-backend';
