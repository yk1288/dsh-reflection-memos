/**
 * 复现/回归:dsh-tools output.render 合约
 *
 * 背景(2026-09-28 线上事故):memos_lookup 的 render 返回裸字符串(而非
 * ContentBlock[]),dsh-tools 的 snapshotProjection 只校验 JSON 可序列化,
 * 字符串被原样提交为 tool-result.content;下一轮请求组装时共享的
 * contentHasImage 递归调用 `content.some(...)` →
 *   TypeError: content.some is not a function
 * 会话历史被污染后每轮 turn 第一步必崩(session-472a5866, seq 1013+)。
 *
 * 本脚本:
 *  1. 直接调用三个工具的 output.render,断言返回**块数组**(合约
 *     dsh-tools/lib/types/index.d.ts: `render(...): ContentBlock[]`);
 *  2. 模拟 dsh-tools createSuccessResult → tool-result 消息 → 共享
 *     contentHasImage 递归,断言不再抛 TypeError;
 *  3. 断言**三个工具**的 output.schema 与其 execute 返回值形状一致(2026-10-10 扩围,
 *     并断言成功路径 ok=true)。
 *
 * 运行:pnpm exec esbuild scripts/repro-render-contract.ts --bundle --format=esm --platform=node --outfile=/tmp/repro-render.mjs && node /tmp/repro-render.mjs
 * (退出码 0 = 合约通过;非 0 = 复现失败)
 */
import { MemoryTools } from '../src/tools/memory-tools';
import { AuditLogger } from '../src/audit/logger';
import { MemoryStore } from '../src/core/memory-store';

let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** dsh-llm/lib/index.js contentHasImage 的同构递归(事故崩溃点) */
function contentHasImage(content: unknown): boolean {
  return (content as { some: (fn: (b: { type: string; content?: unknown }) => boolean) => boolean }).some(
    (block) => block.type === 'image' || (block.type === 'tool-result' && contentHasImage(block.content)),
  );
}

async function main(): Promise<void> {
  const audit = new AuditLogger('/tmp/repro-render-audit');
  const store = new MemoryStore({ writerProvider: null, audit, ledgerDir: `/tmp/repro-render-${Date.now()}` });
  const seed = store.ledger.createEntry({
    content: '复现脚本种子教训', kind: 'lesson', patternKey: 'repro.render',
    failureCount: 1, triage: 'pending',
  });
  // 2026-10-10:种子必须落账本,否则 ack/correct 走失败分支,形状断言会失真
  store.ledger.upsert(seed);
  const tools = new MemoryTools({ emit: () => {} } as never, audit, store, () => ({ correctPerDayLimit: 2 }));

  const lookup = (tools as unknown as { lookupTool(): any }).lookupTool();
  const ack = (tools as unknown as { ackTool(): any }).ackTool();
  const correct = (tools as unknown as { correctTool(): any }).correctTool();

  console.log('\n[1] render 返回值必须是 ContentBlock[]');
  const lookupValue = { ok: true, current: [], recalled: [{ patternKey: 'repro.render', failureCount: 1, importance: 0.9, text: '种子' }] };
  const ackValue = { ok: true, acknowledged: true, patternKey: 'repro.render' };
  const correctValue = { ok: true, registered: 'correction-request', memoryKey: 'k', note: 'n' };
  const cases: Array<[string, any, unknown]> = [
    ['memos_lookup', lookup, lookupValue],
    ['memos_lesson_ack', ack, ackValue],
    ['memos_correct', correct, correctValue],
  ];
  for (const [name, tool, value] of cases) {
    const rendered: unknown = tool.output.render({}, value);
    check(`${name} render 返回数组`, Array.isArray(rendered), `实际 ${typeof rendered}: ${JSON.stringify(rendered)?.slice(0, 120)}`);
    if (Array.isArray(rendered)) {
      check(`${name} 每块为 {type:'text',text:string}`,
        rendered.every((b: any) => b && b.type === 'text' && typeof b.text === 'string'),
        JSON.stringify(rendered).slice(0, 160));
    }
  }

  console.log('\n[2] 模拟 tool-result 消息走 contentHasImage(事故崩溃点)');
  for (const [name, tool, value] of cases) {
    const rendered: unknown = tool.output.render({}, value);
    const messageContent = [{ type: 'tool-result', toolCallId: 'call_x', content: rendered }];
    try {
      contentHasImage(messageContent);
      check(`${name}: contentHasImage 不抛错`, true);
    } catch (error) {
      check(`${name}: contentHasImage 不抛错`, false, String(error));
    }
  }

  console.log('\n[3] output.schema 与 execute 返回形状一致(三工具,2026-10-10 扩围)');
  const probeCases: Array<[string, any, Record<string, unknown>]> = [
    ['memos_lookup', lookup, { query: '契约回归' }],
    ['memos_lesson_ack', ack, { patternKey: 'repro.render' }],
    ['memos_correct', correct, { memoryKey: seed.memoryKey, reason: '这是一条用于 render 契约回归的更正理由' }],
  ];
  for (const [name, tool, args] of probeCases) {
    const result: any = await tool.execute(args);
    const schemaType = tool.output?.schema?.type;
    const actual = Array.isArray(result) ? 'array' : typeof result;
    const shapeOk = schemaType === 'object'
      ? typeof result === 'object' && result !== null && !Array.isArray(result)
      : actual === schemaType;
    check(`${name} schema(${schemaType}) 与返回值(${actual}) 匹配`, shapeOk, JSON.stringify(result)?.slice(0, 160));
    check(`${name} execute 成功路径 ok=true`, result?.ok === true, JSON.stringify(result)?.slice(0, 160));
  }

  if (failed > 0) {
    console.error(`\n❌ 合约回归失败:${failed} 项`);
    process.exit(1);
  }
  console.log('\n✅ render 合约回归全部通过');
}

void main();
