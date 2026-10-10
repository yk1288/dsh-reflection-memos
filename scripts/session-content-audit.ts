/**
 * 会话内容体检 / 修复(2026-10-10 入库;源自 2026-09-28 `content.some` 线上事故)
 *
 * 背景:dsh-tools 的 `output.render` 若返回**裸字符串**(而非 ContentBlock[]),
 * 该字符串会被原样写成 tool-result 内容;之后每轮请求组装时 `dsh-llm` 的
 * `contentHasImage()` 递归 `content.some(...)` → `TypeError: content.some is not a
 * function`,且污染已持久化 → 该会话每轮必崩(无法自愈)。
 *
 * 本脚本对 **v3 / v4 两种已见形态**做体检:
 *  - v3:`tool/result` → `data.message.content[]` 中 `type==='tool-result'` 块的
 *        `content` 必须是数组(事故形态:字符串)
 *  - v4:`tool/result` → `data.message.content` 本身是内容块数组,块必须有字符串 `type`
 *  - 任何 message 事件的 content 不得是非数组标量
 *
 * `--fix` 会:①先备份 `<file>.bak-contentrepair-<时间戳>` ②把字符串内容包装为
 * `[{type:'text',text:<原串>}]` ③用 zstd 原地重写 ④复检。
 *
 * 运行(与 smoke 相同的 esbuild 打包方式,在仓库根执行):
 *   pnpm exec esbuild scripts/session-content-audit.ts --bundle --format=esm --platform=node --outfile=/tmp/session-audit.mjs
 *   node /tmp/session-audit.mjs                     # 只体检(有违规退出码 1)
 *   node /tmp/session-audit.mjs --fix               # 体检并修复(修复后退出码 0)
 *   node /tmp/session-audit.mjs --project --data-home-huangwei-py--   # 限定会话项目目录
 *   node /tmp/session-content-audit.ts --dir ~/.dsh/sessions
 *
 * 退出码:0 = 无违规(或已全部修复);1 = 存在违规且未修复(--fix 未指定或修复失败);2 = 运行错误。
 *
 * 注:验收以"服务能实际打开/继续该会话"为最终标准(见教训);本脚本的
 * `contentHasImage` 探针与 dsh-llm 实现同构,用于给出前后对照证据,并做写回备份。
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface Violation {
  session: string;
  file: string;
  seq?: number;
  where: string;
  got: string;
  snippet: string;
}

/** 与 dsh-llm/lib/index.js:contentHasImage 同构(事故崩溃点);对字符串会抛 TypeError */
function contentHasImage(content: unknown): boolean {
  return (content as { some: (fn: (b: { type: string; content?: unknown }) => boolean) => boolean }).some(
    (block) => block.type === 'image' || (block.type === 'tool-result' && contentHasImage(block.content)),
  );
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function decompress(file: string): string {
  return execFileSync('zstd', ['-d', '-c', file], { encoding: 'utf-8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'] });
}

/** 收集一条事件里所有"会走 contentHasImage"的内容候选 */
function contentCandidates(event: any): Array<{ where: string; value: unknown }> {
  const out: Array<{ where: string; value: unknown }> = [];
  const msg = event?.data?.message;
  const blocks = msg?.content ?? event?.data?.content;
  if (Array.isArray(blocks)) {
    for (const b of blocks) {
      if (b?.type === 'tool-result') out.push({ where: 'tool-result.content', value: b.content });
    }
    out.push({ where: 'message.content', value: blocks });
  } else if (blocks !== undefined) {
    out.push({ where: 'message.content(非数组)', value: blocks });
  }
  return out;
}

/** v4:tool/result 的 message.content 必须是"块对象数组";块 type 必须为字符串 */
function shapeViolations(event: any): Array<{ where: string; got: string; snippet: string }> {
  const bad: Array<{ where: string; got: string; snippet: string }> = [];
  if (event?.type !== 'tool/result') return bad;
  const c = event?.data?.message?.content;
  if (c === undefined) return bad;
  if (!Array.isArray(c)) {
    bad.push({ where: 'v4 tool/result message.content', got: typeof c, snippet: String(JSON.stringify(c)).slice(0, 120) });
    return bad;
  }
  for (const b of c) {
    if (!b || typeof b !== 'object' || typeof b.type !== 'string') {
      bad.push({ where: 'v4 tool/result 块形状', got: b === null ? 'null' : typeof b, snippet: String(JSON.stringify(b)).slice(0, 120) });
    }
  }
  return bad;
}

function probeThrows(raw: string): { checked: number; throws: number } {
  let checked = 0;
  let throws = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    for (const cand of contentCandidates(e)) {
      if (cand.value === undefined) continue;
      checked++;
      try { contentHasImage(cand.value); } catch { throws++; }
    }
  }
  return { checked, throws };
}

function fixLine(event: any): number {
  let fixed = 0;
  const blocks = event?.data?.message?.content;
  if (Array.isArray(blocks)) {
    for (const b of blocks) {
      if (b?.type === 'tool-result' && !Array.isArray(b.content)) {
        const text = typeof b.content === 'string' ? b.content : b.content == null ? '' : JSON.stringify(b.content);
        b.content = [{ type: 'text', text }];
        fixed++;
      }
    }
  } else if (blocks !== undefined && !Array.isArray(blocks)) {
    // 整个 message.content 是标量 → 包装为文本块
    const text = typeof blocks === 'string' ? blocks : JSON.stringify(blocks);
    event.data.message.content = [{ type: 'text', text }];
    fixed++;
  }
  return fixed;
}

function main(): void {
  const root = arg('--dir') ?? path.join(os.homedir(), '.dsh', 'sessions');
  const projectFilter = arg('--project');
  const doFix = process.argv.includes('--fix');
  if (!fs.existsSync(root)) {
    console.error(`会话根目录不存在: ${root}`);
    process.exit(2);
  }

  const sessionFiles: Array<{ session: string; file: string }> = [];
  for (const project of fs.readdirSync(root)) {
    if (projectFilter && project !== projectFilter) continue;
    const pdir = path.join(root, project);
    let st: fs.Stats;
    try { st = fs.statSync(pdir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const session of fs.readdirSync(pdir)) {
      const sdir = path.join(pdir, session);
      let s: fs.Stats;
      try { s = fs.statSync(sdir); } catch { continue; }
      if (!s.isDirectory()) continue;
      const f = fs.readdirSync(sdir).find((x) => x.endsWith('.zstd'));
      if (f) sessionFiles.push({ session, file: path.join(sdir, f) });
    }
  }

  const violations: Violation[] = [];
  let checked = 0;
  let throwsBefore = 0;
  const corrupted: Array<{ session: string; file: string; raw: string }> = [];

  for (const { session, file } of sessionFiles) {
    let raw: string;
    try { raw = decompress(file); } catch { continue; }
    const probe = probeThrows(raw);
    checked += probe.checked;
    throwsBefore += probe.throws;
    let sessionBad = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let e: any;
      try { e = JSON.parse(line); } catch { continue; }
      for (const cand of contentCandidates(e)) {
        if (cand.value !== undefined && !Array.isArray(cand.value)) {
          violations.push({ session, file, seq: e.seq, where: cand.where, got: typeof cand.value, snippet: String(JSON.stringify(cand.value)).slice(0, 120) });
          sessionBad++;
        }
      }
      for (const v of shapeViolations(e)) {
        violations.push({ session, file, seq: e.seq, ...v });
        sessionBad++;
      }
    }
    if (sessionBad > 0) corrupted.push({ session, file, raw });
  }

  console.log(`扫描会话文件=${sessionFiles.length} 检查内容=${checked}`);
  console.log(`结构违规=${violations.length} | contentHasImage 抛错=${throwsBefore}`);
  for (const v of violations.slice(0, 10)) {
    console.log(`  - ${v.session} seq=${v.seq ?? '-'} ${v.where} got=${v.got} ${v.snippet}`);
  }

  if (!doFix) {
    process.exit(violations.length > 0 ? 1 : 0);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let fixedTotal = 0;
  let throwsAfter = 0;
  for (const { session, file, raw } of corrupted) {
    const out: string[] = [];
    let fixed = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let e: any;
      try { e = JSON.parse(line); } catch { out.push(line); continue; }
      fixed += fixLine(e);
      out.push(JSON.stringify(e));
    }
    if (fixed === 0) continue;
    fs.copyFileSync(file, `${file}.bak-contentrepair-${stamp}`);
    execFileSync('zstd', ['-f', '-q', '-o', file], { input: out.join('\n') + '\n' });
    const after = probeThrows(decompress(file));
    throwsAfter += after.throws;
    fixedTotal += fixed;
    console.log(`  ${session}: 修复 ${fixed} 处,备份 ${path.basename(file)}.bak-contentrepair-${stamp},复检抛错=${after.throws}`);
  }
  console.log(`\n修复块数=${fixedTotal} | 修复后 contentHasImage 抛错=${throwsAfter}`);
  console.log(throwsAfter === 0 ? '✅ 全部修复(备份已保留;最终以服务能打开该会话为准)' : '❌ 仍有抛错,需人工检查');
  process.exit(throwsAfter === 0 ? 0 : 1);
}

main();
