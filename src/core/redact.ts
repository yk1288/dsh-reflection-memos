/**
 * 写入脱敏层(v5.0 WriteGate 零审;研究 GAP-1)
 *
 * 移植自 pskoett/self-improving-agent 4.0.2 的 REDACTION_RULES(handler.js 84-92 行),
 * 按 DSH 场景扩充了本地敏感形态(路径、KEY=value 等)。
 * 原则:MemOS 是云端存储,写入/审计一律只落脱敏后文本;
 * 脱敏在"证据校验之后、提交之前"执行,保证评审用的是原文、落库的是净文。
 */

export interface RedactOptions {
  /** 替换占位符,默认 [REDACTED] */
  placeholder?: string;
}

/** 敏感形态:正则 + 说明(顺序即优先级:具体形态在通用形态之前,先命中先用,不重叠处理) */
interface RedactionRule {
  pattern: RegExp;
  label: string;
  /** 可选固定替换模板(保留语义前缀,如 Bearer);缺省整体替换为占位符 */
  replacement?: (placeholder: string) => string;
}

const REDACTION_RULES: RedactionRule[] = [
  // 具体形态优先:Bearer token(保留 "Bearer [REDACTED]" 语义,同 SIA 原版)
  { pattern: /\b(Bearer)\s+([A-Za-z0-9._~+/=-]{8,})/gi, label: 'bearer-token', replacement: (ph) => `Bearer ${ph}` },
  // GitHub 个人访问令牌 gh*_ 前缀 + 16 位以上
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, label: 'github-token' },
  // Slack xox* 令牌
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: 'slack-token' },
  // AWS AKIA 访问密钥
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, label: 'aws-key' },
  // JWT(eyJ 开头三段 base64;签名段允许较短)
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{3,}\b/g, label: 'jwt' },
  // 通用凭据:api_key/token/secret/password/authorization/credential 后跟 = 或 : 的值
  // 负向前瞻排除 Bearer(已由上面的规则处理),避免 authorization: Bearer xxx 被整吞
  { pattern: /\b(api[_-]?key|token|secret|password|passwd|authorization|credential|access[_-]?key|私钥)\b(\s*[=:]\s*)(?!Bearer\b)\S+/gi, label: 'credential' },
  // 通用长 blob(≥40 位无空格字符,疑似 key/hash)
  { pattern: /\b[A-Za-z0-9_-]{40,}\b/g, label: 'long-blob' },
];

/** 对文本执行脱敏;无敏感内容返回原串 */
export function redactText(text: string, options?: RedactOptions): string {
  if (!text) return text;
  const placeholder = options?.placeholder ?? '[REDACTED]';
  let result = text;
  for (const rule of REDACTION_RULES) {
    result = result.replace(rule.pattern, (match, ...groups) => {
      if (rule.replacement) return rule.replacement(placeholder);
      // credential 形态(g1=键名, g2=分隔符)保留键名:token= [REDACTED];其余整体替换
      const g1 = groups[0] as string | undefined;
      const g2 = groups[1] as string | undefined;
      if (typeof g1 === 'string' && typeof g2 === 'string' && rule.label === 'credential') {
        return `${g1}${g2}${placeholder}`;
      }
      void match;
      return placeholder;
    });
  }
  return result;
}

/** 对任意值做深度脱敏(字符串直接处理;对象/数组递归;其他原样返回) */
export function sanitizeValue(value: unknown, options?: RedactOptions): unknown {
  if (typeof value === 'string') return redactText(value, options);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, options));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      // 键名本身若含敏感词也脱敏(如 info.token)
      out[redactText(key, options)] = sanitizeValue(val, options);
    }
    return out;
  }
  return value;
}

/** 单行摘要脱敏 + 截断(审计/注入用,对齐 SIA 的 sanitizeExcerptLine) */
export function sanitizeExcerpt(line: string, maxLength = 200): string {
  let excerpt = redactText(line).split('```').join("'''");
  if (excerpt.length > maxLength) {
    excerpt = `${excerpt.slice(0, maxLength)}…`;
  }
  return excerpt;
}