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
  purpose: "analysis" | "inspection";
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
  endReason?:
    "response" | "cancelled" | "provider_error" | "integration_error" | "truncated" | "interrupted";
}
export interface PermissionRequest {
  id: string;
  runId: string;
  tool: string;
  toolCallId?: string;
  description: string;
  code?: string;
  language?: Language;
  createdAt: string;
}
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
  sessions: SessionInfo[];
  agent: { enabled: boolean; provider?: string; model?: string };
  layout?: unknown;
}
export type AppEvent =
  | { type: "execution"; execution: ExecutionSummary }
  | { type: "outputs"; executionId: string; language: Language }
  | { type: "document"; document: Document }
  | { type: "message"; message: Message }
  | { type: "messages-reset"; conversationId: string }
  | { type: "agent-delta"; runId: string; delta: string }
  | { type: "agent-run"; run: AgentRun }
  | { type: "permission"; request: PermissionRequest }
  | { type: "permission-resolved"; id: string; error?: string }
  | { type: "context"; context: ResearchContext }
  | { type: "conversation"; conversation: Conversation };
