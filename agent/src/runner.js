// Drives Claude Code through the Agent SDK for messages sent from the web UI.
// Uses the local Claude Code login (no API key). One runner per session.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { normalizeRecord } from './transcripts.js';

// Prefer the Claude Code the user already installed and logged into; the SDK's
// bundled binary is the fallback. (Also works around folders where spawning the
// bundled binary fails, e.g. virtualized AppData paths.)
let claudeExe;
export function findClaudeExecutable() {
  if (claudeExe !== undefined) return claudeExe;
  if (process.env.CLAUDE_REMOTE_CLAUDE_PATH && fs.existsSync(process.env.CLAUDE_REMOTE_CLAUDE_PATH)) {
    claudeExe = process.env.CLAUDE_REMOTE_CLAUDE_PATH;
    return claudeExe;
  }
  const win = process.platform === 'win32';
  const candidates = [path.join(os.homedir(), '.local', 'bin', win ? 'claude.exe' : 'claude')];
  try {
    const out = execFileSync(win ? 'where.exe' : 'which', win ? ['claude'] : ['-a', 'claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of out.split(/\r?\n/)) {
      const p = line.trim();
      if (!p) continue;
      if (win && !/\.exe$/i.test(p)) continue; // skip .cmd/.ps1 npm shims (cannot be spawned directly)
      candidates.push(p);
    }
  } catch {
    /* not on PATH */
  }
  claudeExe = candidates.find((c) => {
    try {
      return fs.statSync(c).isFile();
    } catch {
      return false;
    }
  }) || null;
  return claudeExe;
}

const IDLE_CLOSE_MS = 15 * 60 * 1000;

// Environment for the spawned Claude Code. If the agent itself was started from
// inside a Claude Code session, the inherited CLAUDE_CODE_* variables would make
// the child believe it is a nested/hosted session (and report "not logged in").
const STRIP_ENV = /^(CLAUDE_CODE_|CLAUDECODE$|CLAUDE_AGENT_SDK_|CLAUDE_PID$|CLAUDE_TESTER_TOKEN$|CLAUDE_PREVIEW_)/;
export function childEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!STRIP_ENV.test(k)) env[k] = v;
  return env;
}

// Checks whether the local Claude Code is logged in (claude.ai account or API key).
export function checkLogin() {
  const exe = findClaudeExecutable();
  if (!exe) return { ok: null, detail: 'bundled Claude Code' };
  try {
    const out = execFileSync(exe, ['auth', 'status'], { encoding: 'utf8', env: childEnv(), timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] });
    const j = JSON.parse(out);
    return { ok: !!j.loggedIn, detail: j.authMethod || '', exe };
  } catch (err) {
    // `claude auth status` exits non-zero when not logged in, but still prints JSON.
    try {
      const j = JSON.parse(String(err?.stdout || ''));
      if (typeof j.loggedIn === 'boolean') return { ok: j.loggedIn, detail: j.authMethod || '', exe };
    } catch {
      /* fall through */
    }
    return { ok: null, detail: err?.message || 'unknown', exe };
  }
}
const ALLOWED_MODES = new Set(['default', 'acceptEdits', 'plan']);

class PushQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
  }
  push(v) {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.items.push(v);
  }
  close() {
    this.closed = true;
    for (const w of this.waiters) w({ value: undefined, done: true });
    this.waiters = [];
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

export class SessionRunner {
  constructor({ sessionId, cwd, permissionMode, hub, emit, log, onSessionId }) {
    this.sessionId = sessionId || null;
    this.clientRef = null;
    this.cwd = cwd;
    this.permissionMode = ALLOWED_MODES.has(permissionMode) ? permissionMode : 'default';
    this.hub = hub;
    this.emit = emit; // (type, payload)
    this.log = log;
    this.onSessionId = onSessionId;
    this.status = 'idle'; // idle | running | closed
    this.queue = null;
    this.q = null;
    this.abort = null;
    this.idleTimer = null;
    this.startedAt = Date.now();
  }

  get key() {
    return this.sessionId || this.clientRef;
  }

  start() {
    if (this.q) return;
    this.queue = new PushQueue();
    this.abort = new AbortController();
    const options = {
      cwd: this.cwd,
      permissionMode: this.permissionMode,
      includePartialMessages: true,
      abortController: this.abort,
      canUseTool: (toolName, input, opts) => this.handlePermission(toolName, input, opts),
      env: { ...childEnv(), CLAUDE_REMOTE_SDK: '1' },
      stderr: (d) => {
        const s = String(d).trim();
        if (s) this.log(`[claude] ${s.slice(0, 500)}`);
      },
    };
    if (this.sessionId) options.resume = this.sessionId;
    const exe = findClaudeExecutable();
    if (exe) options.pathToClaudeCodeExecutable = exe;
    this.q = query({ prompt: this.queue, options });
    this.loop().catch((err) => {
      this.log(`runner loop error: ${err?.message || err}`);
    });
  }

  async loop() {
    try {
      for await (const msg of this.q) this.handleMessage(msg);
      this.finish('closed');
    } catch (err) {
      const message = err?.message || String(err);
      this.log(`runner error (${this.key}): ${message}`);
      this.emit('error', { sessionId: this.sessionId, clientRef: this.clientRef, message });
      this.finish('error');
    }
  }

  finish(reason) {
    if (this.status === 'closed') return;
    this.status = 'closed';
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.sessionId) this.hub.cancelForSession(this.sessionId, reason);
    this.emit('status', { sessionId: this.sessionId, clientRef: this.clientRef, status: 'idle', source: 'sdk', reason });
    this.emit('runner_closed', { sessionId: this.sessionId, clientRef: this.clientRef });
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          const prev = this.sessionId;
          this.sessionId = msg.session_id;
          this.cwd = msg.cwd || this.cwd;
          if (prev !== this.sessionId) this.onSessionId?.(this, prev);
          this.emit('session_init', {
            clientRef: this.clientRef,
            sessionId: this.sessionId,
            cwd: this.cwd,
            model: msg.model,
            permissionMode: msg.permissionMode,
            apiKeySource: msg.apiKeySource,
            claudeCodeVersion: msg.claude_code_version,
          });
        }
        break;
      }
      case 'stream_event': {
        if (msg.parent_tool_use_id) break;
        const ev = msg.event;
        if (!ev) break;
        if (ev.type === 'message_start') this.emit('partial_reset', { sessionId: this.sessionId });
        else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          this.emit('partial', { sessionId: this.sessionId, text: ev.delta.text });
        } else if (ev.type === 'message_stop') this.emit('partial_reset', { sessionId: this.sessionId });
        break;
      }
      case 'assistant':
      case 'user': {
        const n = normalizeRecord(msg);
        if (n) this.emit('message', { sessionId: this.sessionId, message: n, live: true });
        break;
      }
      case 'result': {
        this.status = 'idle';
        this.emit('result', {
          sessionId: this.sessionId,
          subtype: msg.subtype,
          isError: !!msg.is_error,
          durationMs: msg.duration_ms,
          numTurns: msg.num_turns,
          totalCostUsd: msg.total_cost_usd,
          result: msg.subtype === 'success' ? (msg.result || '') : (msg.errors || []).join('\n'),
        });
        this.emit('status', { sessionId: this.sessionId, status: 'idle', source: 'sdk' });
        this.armIdleTimer();
        break;
      }
      default:
        break;
    }
  }

  armIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.status === 'idle') this.close();
    }, IDLE_CLOSE_MS);
  }

  // images: [{ type: 'image/jpeg', data: base64 }] -> sent as image content blocks before the text.
  send(text, images = []) {
    if (this.status === 'closed') throw new Error('runner closed');
    if (!this.q) this.start();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.status = 'running';
    const content = images.length
      ? [...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.type, data: im.data } })), ...(text ? [{ type: 'text', text }] : [])]
      : text;
    this.queue.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: this.sessionId || '',
    });
    this.emit('status', { sessionId: this.sessionId, clientRef: this.clientRef, status: 'running', source: 'sdk' });
  }

  async setPermissionMode(mode) {
    if (!ALLOWED_MODES.has(mode) || !this.q) return;
    this.permissionMode = mode;
    try {
      await this.q.setPermissionMode(mode);
    } catch (err) {
      this.log(`setPermissionMode failed: ${err?.message || err}`);
    }
  }

  async interrupt() {
    if (this.sessionId) this.hub.cancelForSession(this.sessionId, 'interrupted');
    if (!this.q) return;
    try {
      await this.q.interrupt();
    } catch (err) {
      this.log(`interrupt failed: ${err?.message || err}`);
    }
  }

  close() {
    if (this.sessionId) this.hub.cancelForSession(this.sessionId, 'closed');
    try {
      this.queue?.close();
    } catch {
      /* ignore */
    }
    try {
      this.q?.close();
    } catch {
      /* ignore */
    }
    try {
      this.abort?.abort();
    } catch {
      /* ignore */
    }
    this.finish('closed');
  }

  async handlePermission(toolName, input, opts) {
    const kind = toolName === 'AskUserQuestion' ? 'question' : 'permission';
    const { id, promise } = this.hub.create({
      sessionId: this.sessionId,
      cwd: this.cwd,
      kind,
      toolName,
      input,
      suggestions: opts?.suggestions || [],
      source: 'sdk',
      timeoutMs: 0,
    });
    this.emit('status', { sessionId: this.sessionId, status: 'waiting', source: 'sdk' });
    const onAbort = () => this.hub.finish(id, null, 'aborted');
    opts?.signal?.addEventListener('abort', onAbort, { once: true });
    const answer = await promise;
    opts?.signal?.removeEventListener('abort', onAbort);
    if (this.status !== 'closed') this.emit('status', { sessionId: this.sessionId, status: 'running', source: 'sdk' });

    if (kind === 'question') {
      if (!answer || !answer.answers) {
        return { behavior: 'deny', message: 'The user did not answer the question.' };
      }
      const updatedInput = { questions: input.questions, answers: answer.answers };
      if (answer.response) updatedInput.response = answer.response;
      return { behavior: 'allow', updatedInput };
    }
    if (!answer || answer.behavior !== 'allow') {
      return {
        behavior: 'deny',
        message: answer?.message?.trim() || 'The user denied this action from Claude Remote.',
      };
    }
    const result = { behavior: 'allow', updatedInput: input };
    if (answer.always && Array.isArray(opts?.suggestions) && opts.suggestions.length) {
      result.updatedPermissions = opts.suggestions;
    }
    return result;
  }
}

export class RunnerManager {
  constructor({ hub, emit, log }) {
    this.hub = hub;
    this.emit = emit;
    this.log = log;
    this.runners = new Map(); // key (sessionId or clientRef) -> runner
  }

  get(sessionId) {
    return this.runners.get(sessionId) || null;
  }

  list() {
    return [...this.runners.values()].map((r) => ({
      sessionId: r.sessionId,
      clientRef: r.clientRef,
      cwd: r.cwd,
      status: r.status,
      permissionMode: r.permissionMode,
    }));
  }

  getOrCreate({ sessionId, clientRef, cwd, permissionMode }) {
    if (sessionId) {
      const existing = this.runners.get(sessionId);
      if (existing && existing.status !== 'closed') return existing;
      if (existing) this.runners.delete(sessionId);
    }
    const runner = new SessionRunner({
      sessionId,
      cwd,
      permissionMode,
      hub: this.hub,
      emit: this.emit,
      log: this.log,
      onSessionId: (r, prevKey) => {
        if (prevKey) this.runners.delete(prevKey);
        if (r.clientRef) this.runners.delete(r.clientRef);
        this.runners.set(r.sessionId, r);
      },
    });
    runner.clientRef = clientRef || null;
    this.runners.set(sessionId || clientRef, runner);
    const origFinish = runner.finish.bind(runner);
    runner.finish = (reason) => {
      origFinish(reason);
      if (this.runners.get(runner.key) === runner) this.runners.delete(runner.key);
    };
    return runner;
  }

  closeAll() {
    for (const r of this.runners.values()) r.close();
    this.runners.clear();
  }
}
