export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; isError: boolean; text: string }
  | { type: 'image'; url?: string }; // url: local preview of an image sent from this device

// An image picked on the phone, resized on the device, sent to the agent as base64.
export interface Attachment {
  name: string;
  type: string; // image/jpeg | image/png | image/webp
  data: string; // base64, no data: prefix
  url: string; // data URL for the preview
}

export interface Msg {
  uuid?: string;
  role: 'user' | 'assistant';
  ts: string;
  messageId?: string;
  model?: string;
  stopReason?: string;
  blocks: Block[];
  optimistic?: boolean;
}

export interface SessionMeta {
  id: string;
  cwd: string;
  title: string;
  firstPrompt: string;
  createdAt: string;
  updatedAt: string;
  size: number;
  gitBranch?: string;
  entrypoint?: string;
  // Filled when the Claude desktop app is installed on the PC.
  section?: string | null; // sidebar section (custom group) id
  archived?: boolean;
  pinned?: boolean;
}

// A custom sidebar section of the Claude desktop app's Code tab, in sidebar order.
export interface SidebarSection {
  id: string;
  name: string;
  order: number;
  collapsed: boolean;
}

export interface SessionState {
  sessionId: string;
  status: 'idle' | 'running' | 'waiting' | 'ended';
  source: 'sdk' | 'hook';
  cwd: string;
  updatedAt: string;
  held?: boolean; // the Stop hook is holding the session: a message from here is delivered at once
  staleHooks?: boolean; // the session started with older hooks: Claude Code cuts the Stop hold short
}

export interface PermissionSuggestion {
  type: string;
  destination?: string;
  behavior?: string;
  rules?: { toolName: string; ruleContent?: string }[];
  [k: string]: unknown;
}

export interface Question {
  question: string;
  header?: string;
  options: { label: string; description?: string; preview?: string }[];
  multiSelect?: boolean;
}

export interface PendingRequest {
  id: string;
  sessionId: string | null;
  cwd: string;
  kind: 'permission' | 'question';
  toolName: string;
  input: Record<string, unknown> & { questions?: Question[] };
  suggestions: PermissionSuggestion[];
  source: 'sdk' | 'hook';
  createdAt: string;
  expiresAt: string | null;
}

export interface AgentInfo {
  name: string;
  version: string;
  platform: string;
  hooks: { installed: boolean; events: string[] };
  hookWaitSeconds: number;
  stopHoldSeconds?: number;
  loggedIn: boolean | null;
  push?: { publicKey: string; subscriptions: number } | null;
}

export interface Project {
  cwd: string;
  updatedAt: string;
  count: number;
  exists: boolean;
}

export interface Connection {
  url: string; // ws(s)://host[:port]
  token: string;
  name?: string;
}
