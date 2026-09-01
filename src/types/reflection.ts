/**
 * 反思闭环核心类型(v3.2 文档 3.3 / 3.4 / 3.5)
 */

/** 反思输入:观察层采集、传给 Reviewer 子代理 */
export interface KeyEvent {
  seq: number;
  time: number;
  turn: number;
  type: string;
  summary: string;
}

export interface ReflectionInput {
  taskGoal: string;
  successCriteria: string[];
  /** 执行轨迹摘要(控制 token,不传全量) */
  trajectorySummary: string;
  keyEvents: KeyEvent[];
  userFeedback?: string;
}

/** 可提交 MemOS 的验证事实 */
export interface VerifiedFact {
  fact: string;
  verificationMethod: string;
  evidence: string;
  confidence: number; // 0-1
  category: 'technical' | 'process' | 'preference' | 'domain-knowledge';
  tags: string[];
}

/** 可提交 MemOS 的教训 */
export interface Lesson {
  scenario: string;
  mistake: string;
  correctApproach: string;
  evidence: string;
  confidence: number;
  applicableScenarios: string[];
  failureCount: number;
  severity: 'high' | 'medium' | 'low';
}

/** 改进建议(Skill / 流程 / 规划模板) */
export interface Improvement {
  whatToChange: string;
  howToChange: string;
  howToVerify: string;
  target: 'skill' | 'process' | 'plan_template';
}

export interface ErrorAnalysis {
  step: string;
  error: string;
  rootCause?: string;
  severity: 'high' | 'medium' | 'low';
}

/** 反思输出契约(由 outputSchema 强制) */
export interface ReflectionResult {
  version: '1.0';
  taskSuccess: boolean;
  overallScore: number; // 0-1
  errors: ErrorAnalysis[];
  verifiedFacts: VerifiedFact[];
  lessons: Lesson[];
  improvements: Improvement[];
}

/** 单条写入结果(审计用) */
export interface MemoryWriteResult {
  type: 'fact' | 'lesson';
  content: string;
  submitted: boolean;
  ingested: boolean;
  taskId?: string;
  error?: string;
  at: string;
}

/** 反思闭环统计(/memos-stat) */
export interface ReflectionStats {
  totalSubmitted: number;
  totalIngested: number;
  totalFailed: number;
  todayWritten: number;
  factCount: number;
  lessonCount: number;
}