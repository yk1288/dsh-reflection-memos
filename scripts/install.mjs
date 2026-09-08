#!/usr/bin/env node
/**
 * dsh-reflection-memos 一键安装脚本(v5.0:便于其他电脑安装)
 *
 * 用法:
 *   node scripts/install.mjs [--profile web] [--tgz path/to/pkg.tgz] [--skip-build]
 *
 * 完成四步(幂等,重复执行安全):
 *   1. 构建(tsup)并打包(pnpm pack)生成 tgz —— 或直接用 --tgz 指定现成包
 *   2. dsh plugin --profile <profile> add <tgz>
 *   3. 注入 id 到 ~/.dsh/profiles/<profile>/cordis.patch.yml(已存在则跳过)
 *   4. 打印重启与环境变量说明(MEMOS_API_KEY / MEMOS_USER_ID)
 *
 * 依赖:目标电脑已安装 dsh 命令(DSH 运行时),本机 pnpm/node。
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILES_DIR = path.join(os.homedir(), '.dsh', 'profiles');

function arg(name, fallback) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}
function hasFlag(name) {
  return process.argv.includes(name);
}
function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { stdio: 'pipe', encoding: 'utf-8', ...opts }).trim();
  } catch (error) {
    throw new Error(`执行失败: ${cmd} ${args.join(' ')}\n${error.stderr ?? error.message}`);
  }
}
function tryRun(cmd, args) {
  try {
    return run(cmd, args).trim();
  } catch {
    return '';
  }
}

function patchBlockInsert(pluginId) {
  return `\n# dsh-reflection-memos(v5.0 一键安装注入,幂等)\n- insert:\n    - id: ${pluginId}\n      name: '${pluginId}'\n`;
}

function patchAlreadyInjected(patchPath, pluginId) {
  if (!fs.existsSync(patchPath)) return false;
  return fs.readFileSync(patchPath, 'utf-8').includes(`id: ${pluginId}`);
}

async function main() {
  const profile = arg('--profile', process.env.DSH_PROFILE ?? 'web');
  const pluginId = arg('--plugin-id', 'dsh-reflection-memos');
  const skipBuild = hasFlag('--skip-build');
  console.log(`[sia-install] profile=${profile} plugin=${pluginId}`);

  // 0. 前置检查:dsh 命令可用
  const dshBin = tryRun('which', ['dsh']);
  if (!dshBin) {
    console.error('[sia-install] 未找到 dsh 命令。请先安装 DeepSeek Harness(DSH)并确保 dsh 在 PATH。');
    process.exit(1);
  }

  // 1. 构建 + 打包 → tgz(--skip-build 跳过构建,直接 pack)
  if (!skipBuild) {
    console.log('[sia-install] 构建中 (tsup)...');
    run('pnpm', ['build'], { cwd: ROOT });
  } else {
    console.log('[sia-install] --skip-build,跳过构建');
  }
  console.log('[sia-install] 打包中 (pnpm pack)...');
  const packOut = run('pnpm', ['pack', '--pack-destination', ROOT], { cwd: ROOT });
  // pack 输出多行(Tarball Details + 文件名…),取其中唯一的 .tgz 行
  const tgzName = packOut
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.endsWith('.tgz'));
  if (!tgzName) {
    console.error(`[sia-install] 无法从 pack 输出解析 tgz 文件名:\n${packOut}`);
    process.exit(1);
  }
  const tgzPath = path.join(ROOT, tgzName);
  if (!fs.existsSync(tgzPath)) {
    console.error(`[sia-install] 打包产物缺失: ${tgzPath}`);
    process.exit(1);
  }
  console.log(`[sia-install] tgz: ${tgzPath}`);

  // 2. dsh plugin add
  console.log(`[sia-install] 执行 dsh plugin --profile ${profile} add ...`);
  try {
    const out = run('dsh', ['plugin', '--profile', profile, 'add', tgzPath]);
    console.log(out || '[sia-install] dsh plugin add 完成');
  } catch (error) {
    console.warn(`[sia-install] dsh plugin add 失败(继续尝试直接注入 patch):\n${error.message.slice(0, 500)}`);
  }

  // 3. 注入 profile patch(幂等)
  const profileDir = path.join(PROFILES_DIR, profile);
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  if (!fs.existsSync(profileDir)) {
    console.warn(`[sia-install] profile 目录不存在(创建): ${profileDir}`);
    fs.mkdirSync(profileDir, { recursive: true });
  }
  fs.mkdirSync(profileDir, { recursive: true });
  if (patchAlreadyInjected(patchPath, pluginId)) {
    console.log(`[sia-install] ${patchPath} 已包含 ${pluginId},跳过注入`);
  } else {
    fs.appendFileSync(patchPath, patchBlockInsert(pluginId), 'utf-8');
    console.log(`[sia-install] 已注入 ${pluginId} → ${patchPath}`);
  }

  // 4. 说明
  console.log('\n=== 安装完成,最后一步:重启 ===');
  console.log(`  1) 重启 DSH Web(pkill -f "dsh web --no-open" 或按 supervisor 方式重启)`);
  console.log('  2) 确认环境变量(写入启动环境的 ~/.bashrc 或 DSH 凭据服务):');
  console.log('     export MEMOS_API_KEY=<你的 MemOS API Key>');
  console.log('     export MEMOS_USER_ID=<userId,与 memos-cloud 一致>');
  console.log('  3) 验证:`/reflect` 或 `/memos-stat` 命令可用');
}

main().catch((error) => {
  console.error(`[sia-install] 失败: ${error.message}`);
  process.exit(1);
});