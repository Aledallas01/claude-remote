// HTTP + WebSocket server of the agent.
//   GET  /health      -> { ok: true }
//   POST /hook        -> hook events from claude-remote-hook.js (loopback + shared secret)
//   GET  /*           -> the web UI if ../web/dist exists (self-hosted mode)
//   WS   /ws          -> the protocol used by the web UI (token authenticated)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { TranscriptStore } from './transcripts.js';
import { RequestHub } from './requests.js';
import { RunnerManager } from './runner.js';
import { handleHookEvent, hooksStatus } from './hooks.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const AUTH_TIMEOUT_MS = 8000;
const MAX_PAYLOAD = 1024 * 1024;
const MAX_PROMPT_CHARS = 100_000;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_MAX = 8;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

// Phones and messaging apps turn '-' into en/em dashes and add invisible characters.
function normalizeToken(t) {
  return String(t)
    .replace(/[​-‍﻿\s]/g, '')
    .replace(/[‐-―−⁃﹘﹣－]/g, '-')
    .replace(/[‗＿]/g, '_');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export class AgentServer {
  constructor(cfg, { log, loggedIn = null }) {
    this.cfg = cfg;
    this.log = log;
    this.loggedIn = loggedIn;
    this.store = new TranscriptStore();
    this.hub = new RequestHub();
    this.states = new Map(); // sessionId -> { status, source, cwd, updatedAt }
    this.queues = new Map(); // sessionId -> [{ text, ts }] messages waiting to be delivered through hooks
    this.clients = new Set(); // authenticated sockets
    this.failures = new Map(); // ip -> [timestamps]
    this.webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
    this.runners = new RunnerManager({
      hub: this.hub,
      emit: (type, payload) => this.onRunnerEvent(type, payload),
      log,
    });
    this.hub.on('created', (request) => this.broadcast({ type: 'request', request }));
    this.hub.on('resolved', (info) => this.broadcast({ type: 'request_resolved', ...info }));
    this.store.on('messages', ({ sessionId, messages }) => {
      for (const message of messages) this.broadcast({ type: 'message', sessionId, message, live: false });
    });
    this.store.on('sessions_changed', () => {
      const payload = JSON.stringify({ type: 'sessions', sessions: this.store.listSessions() });
      if (payload === this.lastSessionsPayload) return;
      this.lastSessionsPayload = payload;
      for (const ws of this.clients) if (ws.readyState === ws.OPEN) ws.send(payload);
    });
    this.store.on('log', (m) => log(m));
  }

  async start() {
    await this.store.scanAll();
    this.store.startWatching();
    this.http = http.createServer((req, res) => this.handleHttp(req, res).catch((err) => {
      this.log(`http error: ${err.message}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }));
    this.wss = new WebSocketServer({ server: this.http, path: '/ws', maxPayload: MAX_PAYLOAD });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    this.wss.on('error', (err) => this.log(`websocket server error: ${err.message}`)); // ws re-emits http errors here
    await new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.cfg.port, this.cfg.host, () => {
        this.http.off('error', reject);
        resolve();
      });
    });
  }

  stop() {
    this.runners.closeAll();
    this.store.stop();
    for (const ws of this.clients) ws.close(1001, 'agent shutting down');
    this.wss?.close();
    this.http?.close();
  }

  // ---------- HTTP ----------

  async handleHttp(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (url.pathname === '/hook') return this.handleHookHttp(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    if (fs.existsSync(this.webDist)) return this.serveStatic(url.pathname, res);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>Claude Remote agent</title>` +
        `<body style="font-family:system-ui;padding:2rem;background:#111;color:#eee">` +
        `<h1>Claude Remote agent is running</h1><p>Open <a style="color:#8ab4f8" href="${escapeHtml(this.cfg.webUrl)}">${escapeHtml(this.cfg.webUrl)}</a> and use the link printed in the agent console.</p></body>`,
    );
  }

  serveStatic(pathname, res) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const file = path.normalize(path.join(this.webDist, rel));
    if (!file.startsWith(this.webDist) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      return res.end('not found');
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    fs.createReadStream(file).pipe(res);
  }

  async handleHookHttp(req, res) {
    const remote = req.socket.remoteAddress || '';
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (!loopback || req.method !== 'POST' || !safeEqual(req.headers['x-claude-remote-secret'] || '', this.cfg.hookSecret)) {
      res.writeHead(403);
      return res.end();
    }
    const body = await readBody(req, 2 * 1024 * 1024);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    const event = String(parsed?.event || '');
    const payload = parsed?.payload && typeof parsed.payload === 'object' ? parsed.payload : {};
    let out = {};
    try {
      out = await handleHookEvent(event, payload, {
        hub: this.hub,
        states: this.states,
        queues: this.queues,
        emit: (type, p) => this.onRunnerEvent(type, p),
        clientCount: () => this.clients.size,
        cfg: this.cfg,
        log: this.log,
      });
    } catch (err) {
      this.log(`hook ${event} failed: ${err.message}`);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out || {}));
  }

  // ---------- WebSocket ----------

  clientIp(req) {
    return String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown');
  }

  tooManyFailures(ip) {
    const now = Date.now();
    const list = (this.failures.get(ip) || []).filter((t) => now - t < FAIL_WINDOW_MS);
    this.failures.set(ip, list);
    return list.length >= FAIL_MAX;
  }

  recordFailure(ip) {
    const list = this.failures.get(ip) || [];
    list.push(Date.now());
    this.failures.set(ip, list);
  }

  onConnection(ws, req) {
    const ip = this.clientIp(req);
    if (this.tooManyFailures(ip)) {
      ws.close(4029, 'too many failed attempts');
      return;
    }
    let authed = false;
    const authTimer = setTimeout(() => {
      if (!authed) ws.close(4001, 'auth timeout');
    }, AUTH_TIMEOUT_MS);
    const subs = new Set();
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));

    ws.on('message', async (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (!authed) {
        if (msg.type === 'auth' && typeof msg.token === 'string' && safeEqual(normalizeToken(msg.token), this.cfg.token)) {
          authed = true;
          clearTimeout(authTimer);
          this.clients.add(ws);
          this.log(`client connected (${this.clients.size} total)`);
          this.send(ws, {
            type: 'hello',
            agent: this.agentInfo(),
            sessions: this.store.listSessions(),
            states: this.statesList(),
            pending: this.hub.list(),
            runners: this.runners.list(),
            queued: this.queuedCounts(),
          });
        } else {
          this.recordFailure(ip);
          const got = typeof msg.token === 'string' ? msg.token : '';
          this.log(`auth failed from ${ip} (${msg.type === 'auth' ? `token length ${got.length}, expected ${this.cfg.token.length}${got.length === this.cfg.token.length ? ', same length but different' : ''}` : `first message was "${msg.type}"`})`);
          ws.close(4003, `unauthorized expected=${this.cfg.token.length}`);
        }
        return;
      }
      try {
        await this.handleClientMessage(ws, msg, subs);
      } catch (err) {
        this.log(`client message error: ${err.message}`);
        this.send(ws, { type: 'error', reqId: msg.reqId, message: err.message });
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      this.clients.delete(ws);
      for (const id of subs) this.releaseSubscription(id);
      if (authed) this.log(`client disconnected (${this.clients.size} total)`);
    });
    ws.on('error', () => {});
  }

  releaseSubscription(id) {
    for (const ws of this.clients) if (ws.subs?.has(id)) return;
    this.store.unsubscribe(id);
  }

  agentInfo() {
    return {
      name: this.cfg.agentName,
      version: VERSION,
      platform: process.platform,
      hooks: hooksStatus(),
      hookWaitSeconds: this.cfg.hookWaitSeconds,
      loggedIn: this.loggedIn,
    };
  }

  statesList() {
    return [...this.states.entries()].map(([sessionId, s]) => ({ sessionId, ...s }));
  }

  queuedCounts() {
    const out = {};
    for (const [id, q] of this.queues) if (q.length) out[id] = q.length;
    return out;
  }

  // A session that hooks reported as open in another client recently (and not ended).
  isLiveElsewhere(sessionId) {
    const s = this.states.get(sessionId);
    if (!s || s.source !== 'hook' || s.status === 'ended') return false;
    const age = Date.now() - new Date(s.updatedAt).getTime();
    return age < 12 * 60 * 60 * 1000;
  }

  async handleClientMessage(ws, msg, subs) {
    const { type, reqId } = msg;
    switch (type) {
      case 'ping':
        return this.send(ws, { type: 'pong', reqId });
      case 'list_sessions':
        return this.send(ws, { type: 'sessions', reqId, sessions: this.store.listSessions() });
      case 'list_projects':
        return this.send(ws, { type: 'projects', reqId, projects: this.projects() });
      case 'open_session': {
        const id = String(msg.sessionId || '');
        if (!UUID_RE.test(id)) throw new Error('invalid session id');
        const history = await this.store.loadHistory(id);
        this.store.subscribe(id);
        subs.add(id);
        ws.subs = subs;
        return this.send(ws, {
          type: 'history',
          reqId,
          sessionId: id,
          meta: this.store.getMeta(id) ? publicMetaOf(this.store.getMeta(id)) : null,
          messages: history.messages,
          truncated: !!history.truncated,
        });
      }
      case 'close_session': {
        const id = String(msg.sessionId || '');
        subs.delete(id);
        this.releaseSubscription(id);
        return this.send(ws, { type: 'ok', reqId });
      }
      case 'send': {
        const text = typeof msg.text === 'string' ? msg.text : '';
        if (!text.trim()) throw new Error('empty message');
        if (text.length > MAX_PROMPT_CHARS) throw new Error('message too long');
        let sessionId = msg.sessionId ? String(msg.sessionId) : null;
        let cwd = typeof msg.cwd === 'string' ? msg.cwd.trim() : '';
        if (sessionId) {
          if (!UUID_RE.test(sessionId)) throw new Error('invalid session id');
          const meta = this.store.getMeta(sessionId) || (await this.store.findFile(sessionId), this.store.getMeta(sessionId));
          if (meta?.cwd) cwd = meta.cwd;
          // Session open in a terminal / the desktop app: deliver through the hooks (no credentials
          // needed, and the terminal owns the conversation so the SDK must not resume it).
          if (this.isLiveElsewhere(sessionId)) {
            const q = this.queues.get(sessionId) || [];
            q.push({ text, ts: new Date().toISOString() });
            this.queues.set(sessionId, q);
            this.broadcast({ type: 'queued', sessionId, count: q.length });
            return this.send(ws, { type: 'ok', reqId, sessionId, delivery: 'hook', queued: q.length });
          }
        }
        if (this.loggedIn === false) {
          throw new Error('Claude Code CLI is not logged in on the PC: run "claude login" once to start sessions from here. Messages to sessions running on the PC are delivered through the hooks instead.');
        }
        if (!cwd) throw new Error('a project folder (cwd) is required for a new session');
        if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`folder not found on this PC: ${cwd}`);
        const clientRef = sessionId ? null : String(msg.clientRef || crypto.randomUUID());
        const runner = this.runners.getOrCreate({
          sessionId,
          clientRef,
          cwd,
          permissionMode: msg.permissionMode,
        });
        if (sessionId && msg.permissionMode && runner.permissionMode !== msg.permissionMode && runner.q) {
          await runner.setPermissionMode(msg.permissionMode);
        }
        if (sessionId) {
          this.store.subscribe(sessionId);
          subs.add(sessionId);
          ws.subs = subs;
        }
        runner.send(text);
        return this.send(ws, { type: 'ok', reqId, sessionId, clientRef });
      }
      case 'interrupt': {
        const id = String(msg.sessionId || '');
        const runner = this.runners.get(id);
        if (runner) await runner.interrupt();
        return this.send(ws, { type: 'ok', reqId });
      }
      case 'unqueue': {
        const id = String(msg.sessionId || '');
        if (this.queues.delete(id)) this.broadcast({ type: 'queued', sessionId: id, count: 0 });
        return this.send(ws, { type: 'ok', reqId });
      }
      case 'respond': {
        const id = String(msg.requestId || '');
        const answer = {
          behavior: msg.behavior === 'allow' ? 'allow' : 'deny',
          always: !!msg.always,
          message: typeof msg.message === 'string' ? msg.message.slice(0, 2000) : '',
          answers: msg.answers && typeof msg.answers === 'object' ? sanitizeAnswers(msg.answers) : undefined,
          response: typeof msg.response === 'string' ? msg.response.slice(0, 4000) : undefined,
          release: !!msg.release,
        };
        const ok = this.hub.finish(id, answer, answer.release ? 'released' : 'answered');
        if (!ok) throw new Error('request no longer pending');
        return this.send(ws, { type: 'ok', reqId });
      }
      case 'get_state':
        return this.send(ws, {
          type: 'state',
          reqId,
          states: this.statesList(),
          pending: this.hub.list(),
          runners: this.runners.list(),
          queued: this.queuedCounts(),
        });
      default:
        throw new Error(`unknown message type: ${type}`);
    }
  }

  projects() {
    const seen = new Map();
    for (const s of this.store.listSessions()) {
      if (!s.cwd) continue;
      const prev = seen.get(s.cwd);
      if (!prev || prev.updatedAt < s.updatedAt) seen.set(s.cwd, { cwd: s.cwd, updatedAt: s.updatedAt, count: (prev?.count || 0) + 1 });
      else prev.count += 1;
    }
    return [...seen.values()]
      .map((p) => ({ ...p, exists: fs.existsSync(p.cwd) }))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  // Events from runners and hooks.
  onRunnerEvent(type, payload) {
    if (type === 'status' && payload.sessionId) {
      if (payload.status === 'ended') this.states.delete(payload.sessionId);
      else {
        const prev = this.states.get(payload.sessionId) || {};
        this.states.set(payload.sessionId, {
          ...prev,
          status: payload.status,
          source: payload.source || prev.source,
          cwd: payload.cwd || prev.cwd || '',
          updatedAt: new Date().toISOString(),
        });
      }
    }
    if (type === 'session_init' && payload.sessionId) {
      this.store.subscribe(payload.sessionId);
      for (const ws of this.clients) {
        ws.subs = ws.subs || new Set();
        ws.subs.add(payload.sessionId);
      }
      this.store.findFile(payload.sessionId).then(() => this.store.markListDirty()).catch(() => {});
    }
    this.broadcast({ type, ...payload });
  }

  send(ws, obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  broadcast(obj) {
    const data = JSON.stringify(obj);
    for (const ws of this.clients) if (ws.readyState === ws.OPEN) ws.send(data);
  }

  startHeartbeat() {
    this.hb = setInterval(() => {
      for (const ws of this.clients) {
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        try {
          ws.ping();
        } catch {
          /* ignore */
        }
      }
    }, 30000);
  }
}

function sanitizeAnswers(answers) {
  const out = {};
  for (const [k, v] of Object.entries(answers).slice(0, 8)) {
    if (typeof v === 'string') out[String(k).slice(0, 500)] = v.slice(0, 2000);
    else if (Array.isArray(v)) out[String(k).slice(0, 500)] = v.filter((x) => typeof x === 'string').map((x) => x.slice(0, 500)).slice(0, 10);
  }
  return out;
}

function publicMetaOf(m) {
  return { id: m.id, cwd: m.cwd, title: m.title || m.firstPrompt, gitBranch: m.gitBranch, createdAt: m.createdAt, updatedAt: m.updatedAt };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
