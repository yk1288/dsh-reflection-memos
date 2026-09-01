/**
 * 反思输出 JSON Schema(plain JSON 对象)
 *
 * ⚠️ subagents 的 outputSchema 有严格约束(assertObjectJsonSchema):
 * 只允许 type / properties / required / additionalItems / items / enum / const / oneOf;
 * 禁止 pattern、format、minimum/maximum 等 numeric bounds。
 * 因此这里手写 plain JSON Schema,而不是 schemastery 的 z 对象。
 */

const severityEnum = { type: 'string', enum: ['high', 'medium', 'low'] } as const;
const categoryEnum = {
  type: 'string',
  enum: ['technical', 'process', 'preference', 'domain-knowledge'],
} as const;
const improvementTargetEnum = {
  type: 'string',
  enum: ['skill', 'process', 'plan_template'],
} as const;

const verifiedFactSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fact: { type: 'string' },
    verificationMethod: { type: 'string' },
    evidence: { type: 'string' },
    confidence: { type: 'number' },
    category: categoryEnum,
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['fact', 'verificationMethod', 'evidence', 'confidence', 'category', 'tags'],
} as const;

const lessonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scenario: { type: 'string' },
    mistake: { type: 'string' },
    correctApproach: { type: 'string' },
    evidence: { type: 'string' },
    confidence: { type: 'number' },
    applicableScenarios: { type: 'array', items: { type: 'string' } },
    failureCount: { type: 'number' },
    severity: severityEnum,
  },
  required: ['scenario', 'mistake', 'correctApproach', 'evidence', 'confidence', 'applicableScenarios', 'failureCount', 'severity'],
} as const;

const errorAnalysisSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    step: { type: 'string' },
    error: { type: 'string' },
    rootCause: { type: 'string' },
    severity: severityEnum,
  },
  required: ['step', 'error', 'severity'],
} as const;

const improvementSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    whatToChange: { type: 'string' },
    howToChange: { type: 'string' },
    howToVerify: { type: 'string' },
    target: improvementTargetEnum,
  },
  required: ['whatToChange', 'howToChange', 'howToVerify', 'target'],
} as const;

export const reflectionSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    version: { type: 'string', const: '1.0' },
    taskSuccess: { type: 'boolean' },
    overallScore: { type: 'number' },
    errors: { type: 'array', items: errorAnalysisSchema },
    verifiedFacts: { type: 'array', items: verifiedFactSchema },
    lessons: { type: 'array', items: lessonSchema },
    improvements: { type: 'array', items: improvementSchema },
  },
  required: ['version', 'taskSuccess', 'overallScore', 'errors', 'verifiedFacts', 'lessons', 'improvements'],
} as const;

export type ReflectionOutputSchema = typeof reflectionSchema;