export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; isError: boolean; text: string }
  | { type: 'image' };

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
  loggedIn: boolean | null;
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
