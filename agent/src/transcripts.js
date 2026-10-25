// Reads Claude Code session transcripts from ~/.claude/projects/**/*.jsonl,
// normalizes them for the web UI and watches them for live changes.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';

export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 64 * 1024;
const MAX_SESSIONS = 400;
const MAX_STRING = 8000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- text helpers ----------

export function cleanText(text) {
  if (typeof text !== 'string') return '';
  let t = text;
  if (/<local-command-stdout>/.test(t) || /<local-command-caveat>/.test(t)) return '';
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  t = t.replace(/<\/?pasted_content[^>]*>/g, ''); // closing tags carry the same id attribute
  const cmd = t.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (cmd) {
    const args = t.match(/<command-args>([\s\S]*?)<\/command-args>/);
    t = `${cmd[1].trim()}${args && args[1].trim() ? ' ' + args[1].trim() : ''}`;
  }
  t = t.replace(/<command-message>[\s\S]*?<\/command-message>/g, '');
  return t.trim();
}

function capString(s, max = MAX_STRING) {
  if (typeof s !== 'string' || s.length <= max) return s;
  return s.slice(0, max) + `\n… [${s.length - max} more characters]`;
}

function trimDeep(value, depth = 0) {
  if (depth > 6) return '[…]';
  if (typeof value === 'string') return capString(value);
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => trimDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = trimDeep(v, depth + 1);
    return out;
  }
  return value;
}

function resultText(content) {
  if (typeof content === 'string') return capString(content);
  if (Array.isArray(content)) {
    return capString(
      content
        .map((c) => {
          if (c?.type === 'text') return c.text;
          if (c?.type === 'image') return '[image]';
          return '';
        })
        .filter(Boolean)
        .join('\n'),
    );
  }
  if (content == null) return '';
  return capString(JSON.stringify(content));
}

// Normalizes one transcript record (or one SDK message of type user/assistant)
// into the shape the UI renders. Returns null for records that carry nothing visible.
export function normalizeRecord(rec) {
  if (!rec || (rec.type !== 'user' && rec.type !== 'assistant')) return null;
  if (rec.isSidechain) return null; // subagent transcripts
  if (rec.isMeta) return null;
  if (rec.parent_tool_use_id) return null; // SDK: subagent messages
  const m = rec.message;
  if (!m) return null;
  const blocks = [];
  const content = m.content;
  if (typeof content === 'string') {
    const t = cleanText(content);
    if (t) blocks.push({ type: 'text', text: capString(t, 60000) });
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      switch (b.type) {
        case 'text': {
          const t = cleanText(b.text);
          if (t) blocks.push({ type: 'text', text: capString(t, 60000) });
          break;
        }
        case 'thinking':
        case 'redacted_thinking':
          blocks.push({ type: 'thinking', text: capString(b.thinking || '', 4000) });
          break;
        case 'tool_use':
          blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: trimDeep(b.input ?? {}) });
          break;
        case 'tool_result':
          blocks.push({
            type: 'tool_result',
            toolUseId: b.tool_use_id,
            isError: !!b.is_error,
            text: resultText(b.content),
          });
          break;
        case 'image':
          blocks.push({ type: 'image' });
          break;
        case 'document':
          blocks.push({ type: 'text', text: '[document]' });
          break;
        default:
          break;
      }
    }
  }
  if (!blocks.length) return null;
  return {
    uuid: rec.uuid,
    role: m.role === 'assistant' ? 'assistant' : 'user',
    ts: rec.timestamp || new Date().toISOString(),
    messageId: m.id,
    model: m.model,
    stopReason: m.stop_reason ?? undefined,
    blocks,
  };
}

// ---------- file helpers ----------

async function readRange(file, start, length) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

function parseLines(text, { dropFirst = false, dropLast = false } = {}) {
  const lines = text.split('\n');
  if (dropFirst) lines.shift();
  if (dropLast) lines.pop();
  const out = [];
  for (const line of lines) {
    const l = line.trim();
    if (!l) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* partial line */
    }
  }
  return out;
}

function firstUserText(rec) {
  if (rec.type !== 'user' || rec.isSidechain || rec.isMeta) return '';
  const c = rec.message?.content;
  if (typeof c === 'string') return cleanText(c);
  if (Array.isArray(c)) {
    for (const b of c) if (b?.type === 'text') {
      const t = cleanText(b.text);
      if (t) return t;
    }
  }
  return '';
}

function shortTitle(s, max = 80) {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

// ---------- session index ----------

export class TranscriptStore extends EventEmitter {
  constructor() {
    super();
    this.index = new Map(); // sessionId -> meta
    this.offsets = new Map(); // sessionId -> byte offset read so far (live tail)
    this.subscribed = new Set();
    this.watcher = null;
    this.pending = new Map(); // file -> timer
    this.listDirty = false;
    this.listTimer = null;
  }

  async scanAll() {
    let dirs = [];
    try {
      dirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
    } catch {
      return [];
    }
    const seen = new Set();
    const jobs = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(PROJECTS_DIR, d.name);
      let files = [];
      try {
        files = await fsp.readdir(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const id = f.slice(0, -6);
        if (!UUID_RE.test(id)) continue;
        seen.add(id);
        jobs.push(this.refreshMeta(id, path.join(dir, f), d.name));
      }
    }
    await Promise.allSettled(jobs);
    for (const id of [...this.index.keys()]) if (!seen.has(id)) this.index.delete(id);
    return this.listSessions();
  }

  async refreshMeta(id, file, projectDir) {
    let st;
    try {
      st = await fsp.stat(file);
    } catch {
      this.index.delete(id);
      return null;
    }
    const prev = this.index.get(id);
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) return prev;

    const meta = {
      id,
      file,
      projectDir,
      cwd: prev?.cwd || '',
      title: prev?.title || '',
      firstPrompt: prev?.firstPrompt || '',
      createdAt: prev?.createdAt || '',
      updatedAt: st.mtime.toISOString(),
      mtimeMs: st.mtimeMs,
      size: st.size,
      gitBranch: prev?.gitBranch || '',
      version: prev?.version || '',
      entrypoint: prev?.entrypoint || '',
      messageCount: prev?.messageCount,
    };

    try {
      if (!prev || !prev.cwd || !prev.firstPrompt) {
        const head = parseLines(await readRange(file, 0, Math.min(HEAD_BYTES, st.size)), {
          dropLast: st.size > HEAD_BYTES,
        });
        for (const rec of head) {
          if (!meta.cwd && rec.cwd) meta.cwd = rec.cwd;
          if (!meta.gitBranch && rec.gitBranch) meta.gitBranch = rec.gitBranch;
          if (!meta.version && rec.version) meta.version = rec.version;
          if (!meta.entrypoint && rec.entrypoint) meta.entrypoint = rec.entrypoint;
          if (!meta.createdAt && rec.timestamp) meta.createdAt = rec.timestamp;
          if (rec.type === 'summary' && rec.summary && !meta.title) meta.title = shortTitle(rec.summary);
          if (rec.type === 'custom-title' && rec.customTitle) meta.title = shortTitle(rec.customTitle);
          if (!meta.firstPrompt) {
            const t = firstUserText(rec);
            if (t) meta.firstPrompt = shortTitle(t, 200);
          }
        }
      }
      // Tail: custom titles are appended later in the file.
      const tailStart = Math.max(0, st.size - TAIL_BYTES);
      const tail = parseLines(await readRange(file, tailStart, st.size - tailStart), { dropFirst: tailStart > 0 });
      for (const rec of tail) {
        if (rec.type === 'custom-title' && rec.customTitle) meta.title = shortTitle(rec.customTitle);
        if (!meta.title && rec.type === 'agent-name' && rec.agentName) meta.title = shortTitle(rec.agentName);
        if (!meta.cwd && rec.cwd) meta.cwd = rec.cwd;
      }
    } catch {
      /* ignore unreadable file */
    }
    if (!meta.cwd) meta.cwd = decodeProjectDir(projectDir);
    this.index.set(id, meta);
    return meta;
  }

  listSessions() {
    const all = [...this.index.values()]
      .filter((m) => m.firstPrompt || m.title)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_SESSIONS);
    return all.map(publicMeta);
  }

  getMeta(id) {
    return this.index.get(id) || null;
  }

  async findFile(id) {
    if (!UUID_RE.test(id)) return null;
    const meta = this.index.get(id);
    if (meta) return meta.file;
    // Not indexed yet (brand new session): look it up on disk.
    try {
      const dirs = await fsp.readdir(PROJECTS_DIR);
      for (const d of dirs) {
        const f = path.join(PROJECTS_DIR, d, `${id}.jsonl`);
        try {
          await fsp.access(f);
          await this.refreshMeta(id, f, d);
          return f;
        } catch {
          /* next */
        }
      }
    } catch {
      /* none */
    }
    return null;
  }

  // Full history of a session, normalized. Also primes the live-tail offset.
  // Loads a page of a conversation. Default: the latest `limit` messages. `before` (a message
  // uuid) returns the `limit` messages preceding it (scrolling up); `after` returns everything
  // that follows it (catching up after a reconnect). Parsing the whole file is cheap; sending
  // it to a phone is not, so paging happens here.
  async loadHistory(id, { limit = 150, before = null, after = null } = {}) {
    const file = await this.findFile(id);
    if (!file) return { messages: [], offset: 0 };
    const messages = [];
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let offset = 0;
    let lineBytes = 0;
    for await (const line of rl) {
      lineBytes = Buffer.byteLength(line, 'utf8') + 1;
      offset += lineBytes;
      const l = line.trim();
      if (!l) continue;
      let rec;
      try {
        rec = JSON.parse(l);
      } catch {
        continue;
      }
      const n = normalizeRecord(rec);
      if (n) messages.push(n);
    }
    try {
      const st = await fsp.stat(file);
      offset = st.size;
    } catch {
      /* keep computed */
    }
    this.offsets.set(id, offset);
    const max = Math.min(2000, Math.max(20, Number(limit) || 150));
    const indexOf = (uuid) => (uuid ? messages.findIndex((m) => m.uuid === uuid) : -1);
    if (after) {
      const i = indexOf(after);
      if (i >= 0) return { messages: messages.slice(i + 1), hasMore: false, truncated: false, mode: 'append', total: messages.length, offset };
      // Unknown anchor (rotated/compacted transcript): fall back to the latest page.
    }
    if (before) {
      const i = indexOf(before);
      if (i >= 0) {
        const start = Math.max(0, i - max);
        return { messages: messages.slice(start, i), hasMore: start > 0, truncated: start > 0, mode: 'prepend', total: messages.length, offset };
      }
    }
    const start = Math.max(0, messages.length - max);
    return { messages: messages.slice(start), hasMore: start > 0, truncated: start > 0, mode: 'replace', total: messages.length, offset };
  }

  subscribe(id) {
    this.subscribed.add(id);
  }

  unsubscribe(id) {
    this.subscribed.delete(id);
    this.offsets.delete(id);
  }

  async readNew(id) {
    const file = await this.findFile(id);
    if (!file) return [];
    let st;
    try {
      st = await fsp.stat(file);
    } catch {
      return [];
    }
    let from = this.offsets.get(id) ?? st.size;
    if (from > st.size) from = 0; // file rewritten
    if (st.size === from) return [];
    const text = await readRange(file, from, st.size - from);
    // Only consume complete lines.
    const lastNl = text.lastIndexOf('\n');
    if (lastNl < 0) return [];
    const complete = text.slice(0, lastNl + 1);
    this.offsets.set(id, from + Buffer.byteLength(complete, 'utf8'));
    const out = [];
    for (const rec of parseLines(complete)) {
      const n = normalizeRecord(rec);
      if (n) out.push(n);
      if (rec.type === 'custom-title' && rec.customTitle) {
        const meta = this.index.get(id);
        if (meta) meta.title = shortTitle(rec.customTitle);
        this.markListDirty();
      }
    }
    return out;
  }

  startWatching() {
    if (this.watcher) return;
    try {
      fs.mkdirSync(PROJECTS_DIR, { recursive: true });
      this.watcher = fs.watch(PROJECTS_DIR, { recursive: true }, (_evt, filename) => {
        if (!filename) return;
        const f = String(filename);
        if (!f.endsWith('.jsonl')) return;
        this.schedule(f);
      });
      this.watcher.on('error', (err) => this.emit('log', `watcher error: ${err.message}`));
    } catch (err) {
      this.emit('log', `cannot watch ${PROJECTS_DIR}: ${err.message}`);
    }
  }

  schedule(relFile) {
    const prev = this.pending.get(relFile);
    if (prev) clearTimeout(prev);
    this.pending.set(
      relFile,
      setTimeout(() => {
        this.pending.delete(relFile);
        this.handleChange(relFile).catch((err) => this.emit('log', `change error: ${err.message}`));
      }, 120),
    );
  }

  async handleChange(relFile) {
    const parts = relFile.split(/[\\/]/);
    const base = parts[parts.length - 1];
    const projectDir = parts.length > 1 ? parts[parts.length - 2] : '';
    const id = base.slice(0, -6);
    if (!UUID_RE.test(id)) return;
    const file = path.join(PROJECTS_DIR, ...parts);
    const before = this.index.get(id);
    const meta = await this.refreshMeta(id, file, projectDir);
    if (!meta) {
      this.markListDirty();
      return;
    }
    if (!before || before.title !== meta.title || before.firstPrompt !== meta.firstPrompt || Math.abs(before.mtimeMs - meta.mtimeMs) > 30000) {
      this.markListDirty();
    } else {
      this.markListDirty(); // order changes with recency; cheap to resend
    }
    if (this.subscribed.has(id)) {
      const messages = await this.readNew(id);
      if (messages.length) this.emit('messages', { sessionId: id, messages });
    }
  }

  markListDirty() {
    if (this.listTimer) return;
    this.listTimer = setTimeout(() => {
      this.listTimer = null;
      this.emit('sessions_changed');
    }, 1000);
  }

  stop() {
    if (this.watcher) this.watcher.close();
    this.watcher = null;
  }
}

function publicMeta(m) {
  return {
    id: m.id,
    cwd: m.cwd,
    title: m.title || m.firstPrompt || '(untitled)',
    firstPrompt: m.firstPrompt.slice(0, 140),
    createdAt: m.createdAt,
    updatedAt: m.updatedAt.slice(0, 16) + ':00.000Z',
    size: m.size,
    gitBranch: m.gitBranch,
    entrypoint: m.entrypoint,
  };
}

// Project dir names encode the cwd with non-alphanumerics replaced by '-'.
// This is lossy, so we only use it as a fallback.
function decodeProjectDir(name) {
  if (!name) return '';
  if (/^[A-Za-z]--/.test(name)) return name[0] + ':\\' + name.slice(3).replace(/-/g, '\\');
  return '/' + name.replace(/^-/, '').replace(/-/g, '/');
}
