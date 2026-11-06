/**
 * Domain types shared across the Helios platform.
 * These are the canonical shapes persisted in SQLite and sent over the API.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type AgentMode =
  | "ask"
  | "plan"
  | "code"
  | "autonomous"
  | "debug"
  | "review"
  | "research";

export const AGENT_MODES: AgentMode[] = [
  "ask",
  "plan",
  "code",
  "autonomous",
  "debug",
  "review",
  "research",
];

export type RunStatus =
  | "queued"
  | "planning"
  | "running"
  | "awaiting_approval"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "blocked"
  | "completed"
  | "failed"
  | "skipped";

export type RiskLevel = "read" | "write" | "destructive" | "network" | "external";
export type PolicyDecision = "allow" | "ask" | "deny";

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectProfile {
  projectId: string;
  languages: string[];
  packageManagers: string[];
  frameworks: string[];
  entrypoints: string[];
  testCommands: string[];
  buildCommands: string[];
  typecheckCommands: string[];
  lintCommands: string[];
  fileCount: number;
  indexedAt: string;
  summary: string;
}

export interface Session {
  id: string;
  projectId: string;
  name: string;
  mode: AgentMode;
  providerId: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Run {
  id: string;
  sessionId: string;
  projectId: string;
  objective: string;
  mode: AgentMode;
  providerId: string | null;
  model: string | null;
  status: RunStatus;
  planSummary: string | null;
  summary: string | null;
  error: string | null;
  replanCount: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface TaskVerification {
  ran: boolean;
  commands: Array<{
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
  }>;
  passed: boolean;
  notes: string[];
}

export interface Task {
  id: string;
  runId: string;
  parentId: string | null;
  title: string;
  description: string;
  acceptance: string | null;
  status: TaskStatus;
  ordinal: number;
  depth: number;
  complexity: number;
  /** IDs of tasks that must complete before this task can start. */
  dependsOn: string[];
  result: string | null;
  verification: TaskVerification | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunEvent {
  id: string;
  runId: string | null;
  sessionId: string | null;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessageRecord {
  id: string;
  sessionId: string;
  runId: string | null;
  role: MessageRole;
  content: string;
  toolCalls: unknown | null;
  toolCallId: string | null;
  createdAt: string;
  meta: Record<string, unknown> | null;
}

export type ToolCallStatus = "pending" | "awaiting_approval" | "running" | "succeeded" | "failed" | "denied";

export interface ToolCallRecord {
  id: string;
  runId: string;
  taskId: string | null;
  toolName: string;
  args: unknown;
  result: unknown;
  status: ToolCallStatus;
  error: string | null;
  risk: RiskLevel | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface Approval {
  id: string;
  runId: string;
  toolCallId: string | null;
  toolName: string;
  action: string;
  description: string;
  risk: RiskLevel;
  status: ApprovalStatus;
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  note: string | null;
}

export type MemoryLayer =
  | "working"
  | "episodic"
  | "semantic"
  | "procedural"
  | "project";

export const MEMORY_LAYERS: MemoryLayer[] = [
  "working",
  "episodic",
  "semantic",
  "procedural",
  "project",
];

export type MemoryStatus = "active" | "superseded" | "archived";

export interface MemorySource {
  type: "run" | "user" | "system" | "indexer";
  runId?: string;
  taskId?: string;
}

export interface MemoryRecord {
  id: string;
  projectId: string;
  layer: MemoryLayer;
  kind: string;
  key: string | null;
  title: string;
  content: string;
  tags: string[];
  importance: number;
  confidence: number;
  source: MemorySource;
  fingerprint: string;
  status: MemoryStatus;
  supersededBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  accessCount: number;
}

export interface MemorySignals {
  vector: number | null;
  keyword: number | null;
  importance: number;
  recency: number;
}

export interface MemorySearchResult extends MemoryRecord {
  score: number;
  signals: MemorySignals;
}

export interface TechnicalDecision {
  id: string;
  projectId: string;
  title: string;
  rationale: string;
  alternatives: string | null;
  consequences: string | null;
  status: "proposed" | "accepted" | "superseded";
  sourceRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ProcedureStatus = "proposed" | "trusted" | "retired";

export interface Procedure {
  id: string;
  projectId: string;
  name: string;
  description: string;
  steps: string[];
  successCount: number;
  failureCount: number;
  status: ProcedureStatus;
  sourceRunId: string | null;
  approvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Checkpoint {
  id: string;
  projectId: string;
  runId: string | null;
  label: string;
  gitRef: string | null;
  patchPath: string | null;
  createdAt: string;
}

export interface UsageRecord {
  id: string;
  runId: string | null;
  sessionId: string | null;
  providerId: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  createdAt: string;
}

export interface ModelInfo {
  providerId: string;
  id: string;
  label: string;
  contextWindow?: number;
  supportsTools: boolean;
  supportsEmbeddings: boolean;
}

export interface ProviderStatus {
  id: string;
  label: string;
  kind: ProviderKind;
  configured: boolean;
  baseUrl: string | null;
  models: string[];
  note?: string;
}

export type ProviderKind = "openai" | "anthropic" | "gemini" | "ollama";

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface Usage {
  tokensIn: number;
  tokensOut: number;
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  toolCalls?: ToolCallRequest[];
  toolCallId?: string;
  toolName?: string;
}

export interface ToolParameterSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
  signal?: AbortSignal;
}

export type ChatStreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; call: ToolCallRequest }
  | { type: "usage"; usage: Usage }
  | { type: "done"; finishReason: string };

export interface ChatResponse {
  text: string;
  toolCalls: ToolCallRequest[];
  usage: Usage;
  finishReason: string;
}

export interface EmbeddingProvider {
  embed(texts: string[], model?: string, signal?: AbortSignal): Promise<number[][]>;
  defaultEmbeddingModel(): string | null;
}

export interface ChatProvider extends Partial<EmbeddingProvider> {
  id: string;
  label: string;
  kind: ProviderKind;
  supportsTools: boolean;
  listModels(): Promise<ModelInfo[]>;
  stream(request: ChatRequest): AsyncGenerator<ChatStreamEvent>;
}

export type VerificationKind = "typecheck" | "lint" | "test" | "build";

export interface VerificationCommandResult {
  kind?: VerificationKind;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface VerificationReport {
  ran: boolean;
  passed: boolean;
  commands: VerificationCommandResult[];
  inspectNotes: string[];
  changedFiles: string[];
}

export interface AgentRunOptions {
  objective: string;
  projectId: string;
  sessionId?: string;
  mode: AgentMode;
  providerId?: string;
  model?: string;
  autoApprove?: boolean;
}

export interface ImprovementInsight {
  id: string;
  projectId: string | null;
  kind: string;
  title: string;
  detail: string;
  score: number;
  createdAt: string;
}

export interface MetricSummary {
  runs: number;
  completedRuns: number;
  failedRuns: number;
  successRate: number;
  toolCalls: number;
  toolSuccessRate: number;
  avgRunSeconds: number | null;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
  verificationRuns: number;
  verificationCoverage: number;
  topFailures: Array<{ tool: string; error: string; count: number }>;
  tools: Array<{ name: string; calls: number; failures: number; successRate: number; avgMs: number }>;
}
