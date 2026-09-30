#!/usr/bin/env node
/**
 * dsh-reflection-memos 一键安装脚本(v5.1:便于其他电脑安装)
 *
 * 用法:
 *   node scripts/install.mjs [--profile web] [--tgz path/to/pkg.tgz] [--skip-build]
 *
 * 完成三步(幂等,重复执行安全):
 *   1. 构建(tsup)并打包(pnpm pack)生成 tgz —— 或直接用 --tgz 指定现成包
 *   2. dsh plugin --profile <profile> add <tgz>
 *   3. 校验插件已并入 profile 的 dsh.profile.bundles,并打印重启说明
 *
 * 为什么不手动注入 profile 的 cordis.patch.yml(旧版第 3 步):
 *   插件自带 `dsh.bundle.patch`,而 dsh-plugin-manager 的 reconcile() 会在
 *   `dsh plugin add` 之后自动把声明了 dsh.bundle 的新依赖并入 dsh.profile.bundles,
 *   该 bundle 的 patch 层(含 insert)随之自动合并。手动再插一次只会产生
 *   重复 loader entry id —— 与 profile 内既有注释的约定相反。
 *
 * 可选环境变量:
 *   DSH_PNPM_STORE  profile 使用的 pnpm store 路径。当 profile 的 node_modules
 *                   与当前 pnpm 默认 store 不一致时必须指定,否则报
 *                   ERR_PNPM_UNEXPECTED_STORE(pnpm 11 只认 CLI/全局配置的
 *                   store-dir,project .npmrc 与 npm_config_store_dir 均被忽略)。
 *   DSH_PKG         PATH 上找不到 dsh 时,npx 回退使用的版本
 *                   (默认 @deepseek-ai/dsh@0.2.0-rc.2)。
 *
 * 依赖:目标电脑已安装 dsh(或在 PATH 上有 npx),本机 pnpm/node。
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILES_DIR = path.join(os.homedir(), '.dsh', 'profiles');

// 运行本脚本的 node 所在目录通常同时提供 pnpm/npx,但交互式登录 shell 的
// PATH 上可能既没有 node 也没有 pnpm;把它补进来(幂等)。
const NODE_BIN = path.dirname(process.execPath);
const PATH_PARTS = (process.env.PATH ?? '').split(path.delimiter);
if (NODE_BIN && !PATH_PARTS.includes(NODE_BIN)) {
  process.env.PATH = `${NODE_BIN}${path.delimiter}${process.env.PATH ?? ''}`;
}

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

/** dsh 优先取 PATH 上的;没有则回退到钉版本 npx(v5.1:本机 PATH 上无 dsh)。 */
function resolveDsh() {
  if (tryRun('which', ['dsh'])) return { label: 'dsh', cmd: 'dsh', prefix: [] };
  if (!tryRun('which', ['npx'])) return null;
  const pkg = process.env.DSH_PKG ?? '@deepseek-ai/dsh@0.2.0-rc.2';
  return { label: `npx -y ${pkg}`, cmd: 'npx', prefix: ['-y', pkg] };
}

async function main() {
  const profile = arg('--profile', process.env.DSH_PROFILE ?? 'web');
  const pluginId = arg('--plugin-id', 'dsh-reflection-memos');
  const skipBuild = hasFlag('--skip-build');
  const storeDir = process.env.DSH_PNPM_STORE ?? '';
  console.log(`[sia-install] profile=${profile} plugin=${pluginId}`);

  // 0. 前置检查:dsh 命令可用(PATH 上没有则用 npx 回退)
  const dsh = resolveDsh();
  if (!dsh) {
    console.error('[sia-install] PATH 上既没有 dsh 也没有 npx。请先安装 DeepSeek Harness(DSH)。');
    process.exit(1);
  }
  if (dsh.cmd !== 'dsh') console.log(`[sia-install] PATH 上无 dsh,回退: ${dsh.label}`);

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

  // 2. dsh plugin add(store 不一致时用 DSH_PNPM_STORE 显式固定)
  const storeArgs = storeDir ? [`--config.store-dir=${storeDir}`] : [];
  if (storeDir) console.log(`[sia-install] pnpm store-dir=${storeDir}`);
  console.log(`[sia-install] 执行 ${dsh.label} plugin --profile ${profile} add ...`);
  let addFailed = null;
  try {
    const out = run(dsh.cmd, [...dsh.prefix, 'plugin', '--profile', profile, 'add', tgzPath, ...storeArgs]);
    console.log(out || '[sia-install] dsh plugin add 完成');
  } catch (error) {
    addFailed = error.message;
    console.warn(`[sia-install] dsh plugin add 失败:\n${addFailed.slice(0, 800)}`);
    if (/ERR_PNPM_UNEXPECTED_STORE/.test(addFailed)) {
      console.warn(
        '[sia-install] 提示:profile 的 node_modules 与当前 pnpm 默认 store 不一致。\n' +
          '           用 DSH_PNPM_STORE=<profile 现有 store> 重跑本脚本即可,\n' +
          '           例如: DSH_PNPM_STORE=~/.local/share/pnpm/store node scripts/install.mjs',
      );
    }
  }

  // 3. 校验插件确实并入 bundles(而不是往 cordis.patch.yml 里再插一条)
  const profileDir = path.join(PROFILES_DIR, profile);
  const manifestPath = path.join(profileDir, 'package.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`[sia-install] 未找到 profile 清单: ${manifestPath}`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  const dependency = manifest.dependencies?.[pluginId];
  if (bundles.includes(pluginId)) {
    console.log(`[sia-install] 已并入 dsh.profile.bundles: ${pluginId}(依赖: ${dependency ?? '未记录'})`);
    console.log('[sia-install] 插件 bundle 自带 patch 层,无需再改 cordis.patch.yml');
  } else {
    console.warn(
      `[sia-install] 警告:${pluginId} 不在 ${manifestPath} 的 dsh.profile.bundles 中。\n` +
        '           插件不会被加载,请检查 `dsh plugin add` 是否真的成功(见上方输出)。',
    );
    if (!addFailed) process.exit(1);
  }

  // 4. 说明
  console.log('\n=== 安装完成,最后一步:重启 ===');
  console.log('  1) 重启 DSH Web(bash ~/.dsh/restart-dsh-web.sh 或按 supervisor 方式重启)');
  console.log('  2) 确认环境变量(写入启动环境的 ~/.bashrc 或 DSH 凭据服务):');
  console.log('     export MEMOS_API_KEY=<你的 MemOS API Key>');
  console.log('     export MEMOS_USER_ID=<userId,与 memos-cloud 一致>');
  console.log('  3) 验证:`/reflect` 或 `/memos-stat` 命令可用');
  if (addFailed) process.exit(1);
}

main().catch((error) => {
  console.error(`[sia-install] 失败: ${error.message}`);
  process.exit(1);
});
