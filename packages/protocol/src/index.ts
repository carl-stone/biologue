export type Language = "python" | "r";
export type Actor = "human" | "agent" | "system";
export type ExecutionStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "cancelled"
  | "abandoned"
  | "completion_unknown"
  | "not_executed";
export interface ContextIssue {
  id: string;
  object?: string;
  kind: "possible_change" | "unobserved" | "kernel_changed" | "unknown";
  message: string;
  executionId?: string;
  observedExecutionId?: string;
  codePreview?: string;
  actor?: Actor;
  status?: ExecutionStatus;
}
export interface ExecutionContextCheck {
  disposition: "clear" | "review" | "acknowledged";
  through: number;
  epoch: string;
  issues: ContextIssue[];
  notes: string[];
  acknowledgment?: { warningExecutionId: string; reason: string };
}
export interface ExecutionSummary {
  id: string;
  language: Language;
  actor: Actor;
  codePreview: string;
  codeHash: string;
  purpose: "analysis" | "inspection" | "setup";
  document?: { path: string; version: number; selection?: { from: number; to: number } };
  runId?: string;
  toolCallId?: string;
  conversationId?: string;
  status: ExecutionStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  sessionId?: string;
  kernelId?: string;
  kernelGeneration?: string;
  kernelUncertain?: boolean;
  activitySequence?: number;
  contextCheck?: ExecutionContextCheck;
  error?: string;
  inspection?: "environment" | "table";
  inspectionOptions?: EnvironmentQuery;
}
export interface Execution extends ExecutionSummary {
  code: string;
}
export interface Output {
  id: string;
  executionId: string;
  sequence: number;
  kind: "stream" | "display" | "result" | "error" | "clear" | "update";
  text?: string;
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  displayId?: string;
  wait?: boolean;
}
/** Immutable output identity; payloads are fetched separately. */
export interface OutputReference {
  id: string;
  executionId: string;
  sequence: number;
  kind: Output["kind"];
  mimeTypes: string[];
  preview: string;
  truncated: boolean;
  table: boolean;
}
/** A display slot may point to a newer immutable output after an update. */
export interface DisplayOutput extends OutputReference {
  slotId: string;
  ownerExecutionId: string;
}
export interface TableResult {
  kind: "table";
  columns: unknown[];
  rows: unknown[][];
  truncated: boolean;
}
export interface EnvironmentQuery {
  names?: string[];
  offset?: number;
}
export interface EnvironmentResult {
  kind: "environment";
  rows: { name: string; type: string; preview: string; observed?: false }[];
  next?: number;
}
export type InspectionResult = TableResult | EnvironmentResult;
export interface Page<T> {
  items: T[];
  next?: string;
}
export interface Document {
  path: string;
  /** An unnamed working document, persisted in the workspace but not on disk. */
  untitled?: boolean;
  /** Retired identity after Save As; revisions remain available for execution provenance. */
  savedAs?: string;
  content: string;
  version: number;
  savedVersion: number;
  diskHash: string;
  diskConflict?: { hash: string | null; content: string | null };
  editId?: string;
}
export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  titleMode?: "automatic" | "manual";
  titledThrough?: number;
  archived?: boolean;
  pinned?: boolean;
  parentId?: string;
  settings?: AgentSettings;
}
export type PermissionMode = "ask" | "plan" | "edit" | "auto";
export interface AgentSettings {
  provider: string;
  model: string;
  thinking: string;
  mode?: PermissionMode;
}
export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  document?: { path: string; version: number };
}
export interface AgentUsage {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  subscription?: boolean;
  context?: { tokens: number | null; contextWindow: number; percent: number | null };
}
export interface AgentActivity {
  id: string;
  tool: string;
  label: string;
  status: "running" | "completed" | "failed";
}
export interface AgentResources {
  skills: { name: string; description: string; path: string }[];
  prompts: { name: string; description: string; path: string }[];
  instructions: { path: string; content: string }[];
  diagnostics: string[];
}
export interface AgentProvider {
  id: string;
  name: string;
  connected: boolean;
  methods: { type: "oauth" | "api_key"; label: string }[];
}
export interface AuthFlow {
  id: string;
  provider: string;
  status: "pending" | "complete" | "cancelled" | "failed";
  message?: string;
  url?: string;
  code?: string;
  prompt?: {
    id: string;
    type: "text" | "secret" | "select" | "manual_code";
    message: string;
    placeholder?: string;
    options?: { id: string; label: string }[];
  };
}
export interface AgentQuestion {
  id: string;
  runId: string;
  conversationId: string;
  kind: "select" | "input" | "confirm";
  title: string;
  options?: string[];
  placeholder?: string;
}
export interface Message {
  /** Ordering within the rebuildable conversation display index. */
  sequence?: number;
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  runId?: string;
  delivery?: "pending" | "delivered";
  queue?: "steer" | "followUp";
  attachments?: Attachment[];
  entryId?: string;
}
export interface ResearchContext {
  text: string;
  version: number;
  updatedAt: string;
}
export interface AgentRun {
  id: string;
  conversationId: string;
  status: "running" | "completed" | "failed" | "cancelled" | "abandoned";
  startedAt: string;
  finishedAt?: string;
  error?: string;
  contextVersion: number;
  piSessionId?: string;
  kind?: "response" | "compaction";
  settings?: AgentSettings;
  phase?: "working" | "compacting" | "retrying";
  phaseDetail?: string;
  usage?: AgentUsage;
  activity?: AgentActivity[];
  notices?: { text: string; level: "info" | "warning" | "error" }[];
  endReason?:
    "response" | "cancelled" | "provider_error" | "integration_error" | "truncated" | "interrupted";
}
export interface PermissionRequest {
  id: string;
  runId: string;
  conversationId?: string;
  tool: string;
  toolCallId?: string;
  description: string;
  code?: string;
  language?: Language;
  document?: { path: string; version: number };
  before?: string;
  createdAt: string;
}
export interface PermissionDecision extends PermissionRequest {
  decision: "allow" | "deny" | "cancelled";
  resolvedAt: string;
  feedback?: string;
}
/** Exact code and prior contents are fetched only when reviewing a past decision. */
export type PermissionDecisionSummary = Omit<PermissionDecision, "code" | "before">;
export interface SessionInfo {
  language: Language;
  sessionId: string;
  kernelId: string;
  status: string;
}
export interface Snapshot {
  project: string;
  files: string[];
  documents: Document[];
  executions: ExecutionSummary[];
  executionCursor?: string;
  conversations: Conversation[];
  researchContext: ResearchContext;
  runs: AgentRun[];
  permissions: PermissionRequest[];
  permissionHistory?: PermissionDecisionSummary[];
  sessions: SessionInfo[];
  agent: { enabled: boolean; provider?: string; model?: string; thinking?: string };
  questions?: AgentQuestion[];
  layout?: unknown;
}
export interface AgentModel {
  provider: string;
  id: string;
  name: string;
  thinkingLevels: string[];
  available?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
  subscription?: boolean;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}
export type AppEvent =
  | { type: "question"; question: AgentQuestion }
  | { type: "question-resolved"; id: string }
  | { type: "agent-settings"; agent: Snapshot["agent"] }
  | { type: "execution"; execution: ExecutionSummary }
  | { type: "outputs"; executionId: string; language: Language }
  | { type: "document"; document: Document }
  | { type: "message"; message: Message }
  | { type: "messages-reset"; conversationId: string }
  | { type: "agent-delta"; runId: string; delta: string }
  | { type: "agent-run"; run: AgentRun }
  | { type: "permission"; request: PermissionRequest }
  | {
      type: "permission-resolved";
      id: string;
      resolution?: PermissionDecisionSummary;
      error?: string;
    }
  | { type: "context"; context: ResearchContext }
  | { type: "conversation"; conversation: Conversation };
