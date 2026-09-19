export type JsonSchema = Record<string, unknown>;
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };
export type ToolCall = { id: string; name: string; arguments: Record<string, unknown> };
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: ContentPart[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  providerData?: { providerId: string; model: string; value: unknown };
}
export interface ModelCapabilities {
  contextWindow: number;
  maxOutputTokens: number;
  tools: boolean;
  images: boolean;
}
export interface ModelRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxOutputTokens: number;
}
export type ModelEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_delta'; id: string; text: string }
  | {
      type: 'done';
      message: Message;
      usage?: { input: number; output: number };
      stopReason: 'stop' | 'tools' | 'length';
    };
export interface ModelProvider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: ModelCapabilities;
  stream(request: ModelRequest, options: { signal: AbortSignal }): AsyncIterable<ModelEvent>;
}
export type ToolEffect = 'read' | 'write' | 'execute' | 'network';
export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}
export interface ToolResult {
  content: ContentPart[];
  isError?: boolean;
  metadata?: Record<string, unknown>;
}
export interface ToolContext {
  workspace: string;
  sessionId: string;
  turnId: string;
  invocationId: string;
  signal: AbortSignal;
  turnSignal?: AbortSignal;
  progress(data: unknown): Promise<void>;
}
export interface Tool extends ToolSpec {
  effect: ToolEffect;
  parallel?: boolean;
  /** Cooperative cancellation is a contract, not a promise that effects can be undone. */
  cancellable?: boolean;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
  close?(): Promise<void>;
}
export type PolicyDecision = 'allow' | 'deny' | 'ask';
export type Policy = (
  tool: Tool,
  args: Record<string, unknown>,
  context: ToolContext,
) => PolicyDecision | Promise<PolicyDecision>;
export interface AgentEvent {
  schemaVersion: 1;
  sessionId: string;
  eventId: string;
  seq: number;
  timestamp: string;
  type: string;
  turnId?: string;
  stepId?: string;
  attemptId?: string;
  messageId?: string;
  data: Record<string, unknown>;
}
export interface SessionMeta {
  id: string;
  createdAt: string;
  workspace: string;
  workspaceId?: string;
  profileId?: string;
  ownerId?: string;
  parentId?: string;
  providerId: string;
  model: string;
  schemaVersion: 1;
}
export interface SessionStore {
  create(meta: SessionMeta): Promise<void>;
  list(): Promise<SessionMeta[]>;
  read(id: string): Promise<{ meta: SessionMeta; events: AgentEvent[] }>;
  acquire(id: string): Promise<() => Promise<void>>;
  append(id: string, event: AgentEvent): Promise<void>;
  putArtifact(id: string, content: string): Promise<string>;
  getArtifact(id: string, artifactId: string): Promise<string>;
}
export type InputMode = 'steer' | 'follow_up' | 'interrupt';
export interface InputRequest {
  inputId: string;
  mode: InputMode;
  content: ContentPart[];
  expectedTurnId?: string;
}
export interface InputReceipt {
  inputId: string;
  acceptedSeq: number;
  turnId?: string;
  status: 'pending' | 'applied' | 'rejected' | 'withdrawn';
}
export interface TurnResult {
  turnId: string;
  status: 'completed' | 'interrupted' | 'failed';
  text: string;
  reason?: string;
}
export interface ContextContributor {
  (context: {
    workspace: string;
    messages: readonly Message[];
    signal: AbortSignal;
  }): Promise<string>;
}
