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
 *  3. 断言 ackTool 的 output.schema 与其 execute 返回值形状一致。
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
  store.ledger.createEntry({
    content: '复现脚本种子教训', kind: 'lesson', patternKey: 'repro.render',
    failureCount: 1, triage: 'pending',
  });
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

  console.log('\n[3] output.schema 与 execute 返回形状一致');
  const ackResult = await ack.execute({ patternKey: 'repro.render' });
  const ackSchemaType = ack.output.schema?.type;
  check(`memos_lesson_ack schema type 与返回值匹配`,
    ackSchemaType === 'object' ? typeof ackResult === 'object' && ackResult !== null : typeof ackResult === ackSchemaType,
    `schema.type=${ackSchemaType}, 返回=${typeof ackResult}: ${JSON.stringify(ackResult)}`);

  if (failed > 0) {
    console.error(`\n❌ 合约回归失败:${failed} 项`);
    process.exit(1);
  }
  console.log('\n✅ render 合约回归全部通过');
}

void main();
