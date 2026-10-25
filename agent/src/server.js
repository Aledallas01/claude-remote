// HTTP + WebSocket server of the agent.
//   GET  /health      -> { ok: true }
//   POST /hook        -> hook events from claude-remote-hook.js (loopback + shared secret)
//   GET  /*           -> the web UI if ../web/dist exists (self-hosted mode)
//   WS   /ws          -> the protocol used by the web UI (token authenticated)
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { TranscriptStore } from './transcripts.js';
import { RequestHub } from './requests.js';
import { RunnerManager } from './runner.js';
import { handleHookEvent, hooksStatus } from './hooks.js';
import { DesktopIndex } from './desktop.js';
import { PushStore } from './push.js';
import { configDir } from './config.js';
import { execFile } from 'node:child_process';

// Which Claude Code sessions have a live process right now, from the process list: the desktop
// app resumes sessions with `--resume=<id>`, so those ids are visible. Cached for a few seconds.
// Sessions started fresh carry no id on the command line; the hook states cover those.
let processScan = { at: 0, ids: new Set(), count: 0 };
function liveProcessSessions() {
  if (Date.now() - processScan.at < 5000) return Promise.resolve(processScan);
  return new Promise((resolve) => {
    const done = (out) => {
      const ids = new Set();
      let count = 0;
      for (const m of String(out || '').matchAll(/--resume[= ]"?([0-9a-f-]{36})/gi)) ids.add(m[1].toLowerCase());
      for (const line of String(out || '').split('\n')) if (/stream-json/.test(line)) count++;
      processScan = { at: Date.now(), ids, count };
      resolve(processScan);
    };
    const opts = { timeout: 8000, maxBuffer: 16 * 1024 * 1024, windowsHide: true };
    if (process.platform === 'win32') {
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='claude.exe' or Name='node.exe'\" | ForEach-Object { $_.CommandLine }"], opts, (err, out) => done(err ? '' : out));
    } else {
      execFile('ps', ['-eo', 'args'], opts, (err, out) => done(err ? '' : out));
    }
  });
}

const WEB_ACTIVE_MS = 60 * 60 * 1000; // a session counts as "in use from the web" for this long

// Messages waiting to be delivered through the hooks, kept on disk so an agent restart does
// not lose them. Entries older than a day are dropped on load.
class QueueStore extends Map {
  constructor(file, log) {
    super();
    this.file = file;
    this.log = log || (() => {});
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const [id, list] of Object.entries(saved || {})) {
        const fresh = (Array.isArray(list) ? list : []).filter((m) => m && typeof m.text === 'string' && new Date(m.ts).getTime() > cutoff);
        if (fresh.length) super.set(id, fresh);
      }
      if (this.size) this.log(`restored ${this.size} queued conversation(s) from disk`);
    } catch {
      /* no saved queue */
    }
  }

  persist() {
    try {
      const obj = {};
      for (const [id, list] of this) if (list.length) obj[id] = list;
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(obj), { mode: 0o600 });
    } catch (err) {
      this.log(`cannot save queue: ${err.message}`);
    }
  }

  set(k, v) {
    super.set(k, v);
    this.persist();
    return this;
  }

  delete(k) {
    const r = super.delete(k);
    if (r) this.persist();
    return r;
  }
}

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
    // sessionId -> { status, source, cwd, updatedAt, ... }. Hook-tracked states are kept on disk
    // so a restart of the agent does not forget which sessions the PC has open.
    this.statesFile = path.join(configDir(), 'states.json');
    this.states = new Map(this.loadStates());
    this.queues = new QueueStore(path.join(configDir(), 'queues.json'), log); // sessionId -> [{ text, ts }] waiting for the hooks
    this.clients = new Set(); // authenticated sockets
    this.failures = new Map(); // ip -> [timestamps]
    this.webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
    this.runners = new RunnerManager({
      hub: this.hub,
      emit: (type, payload) => this.onRunnerEvent(type, payload),
      log,
    });
    this.webActivity = new Map(); // sessionId -> last time a web client opened / wrote to it
    this.webSends = new Map(); // sessionId -> last time a message was sent from the web
    this.appPrompts = new Map(); // sessionId -> last time a prompt was typed in the app / terminal
    this.queueWaiters = new Map(); // sessionId -> resolve(), a Stop hook holding the session
    try {
      this.push = new PushStore(cfg, { log });
    } catch (err) {
      log(`push disabled: ${err.message}`);
      this.push = null;
    }
    this.hub.on('created', (request) => {
      log(`request ${request.id.slice(0, 8)}: ${request.kind} ${request.toolName} for ${String(request.sessionId || '').slice(0, 8)} (${this.clients.size} client(s), push to ${this.push?.count || 0})`);
      this.broadcast({ type: 'request', request });
      this.pushForRequest(request).catch((err) => log(`push: ${err.message}`));
    });
    this.hub.on('resolved', (info) => log(`request ${String(info.id || '').slice(0, 8)}: ${info.reason || 'resolved'}`));
    this.hub.on('resolved', (info) => this.broadcast({ type: 'request_resolved', ...info }));
    this.store.on('messages', ({ sessionId, messages }) => {
      for (const message of messages) this.broadcast({ type: 'message', sessionId, message, live: false });
    });
    this.desktop = new DesktopIndex({ log });
    this.store.on('sessions_changed', () => this.broadcastSessions());
    this.desktop.on('changed', () => this.broadcastSessions());
    this.store.on('log', (m) => log(m));
  }

  // Session list as the web UI sees it: transcript metadata, enriched with the desktop
  // app's title, sidebar section, pinned and archived flags when the app is installed.
  sessionsPayload() {
    const list = this.store.listSessions();
    if (!this.desktop.available) return list;
    return list.map((s) => {
      const d = this.desktop.info(s.id);
      if (!d) return s;
      return { ...s, title: d.title || s.title, section: d.section, archived: d.archived, pinned: d.pinned };
    });
  }

  broadcastSessions() {
    const payload = JSON.stringify({ type: 'sessions', sessions: this.sessionsPayload(), sections: this.desktop.sections });
    if (payload === this.lastSessionsPayload) return;
    this.lastSessionsPayload = payload;
    for (const ws of this.clients) if (ws.readyState === ws.OPEN) ws.send(payload);
  }

  async start() {
    await this.store.scanAll();
    this.store.startWatching();
    try {
      await this.desktop.start();
      if (this.desktop.available) this.log(`desktop app index: ${this.desktop.sections.length} sidebar sections, ${this.desktop.bySession.size} sessions`);
    } catch (err) {
      this.log(`desktop app index unavailable: ${err.message}`);
    }
    this.http = http.createServer((req, res) => this.handleHttp(req, res).catch((err) => {
      this.log(`http error: ${err.message}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }));
    // Compression: conversation JSON shrinks 5-10x, which is what a phone on the tunnel feels.
    this.wss = new WebSocketServer({
      server: this.http,
      path: '/ws',
      maxPayload: MAX_PAYLOAD,
      perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 6 }, clientNoContextTakeover: true, serverNoContextTakeover: true },
    });
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
    this.desktop.stop();
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
      // Hashed assets live forever; the page, the service worker and the manifest must revalidate.
      'cache-control': /^\/assets\//.test(rel) ? 'public, max-age=31536000, immutable' : 'no-cache',
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
    // Claude Code kills a hook that exceeds its configured timeout; the relay then closes this
    // request. A decision produced after that would be lost, so long waits watch this signal.
    const ac = new AbortController();
    // 'close' on the response fires when the connection drops before the reply is sent
    // (on the request it only means the body was consumed).
    res.on('close', () => {
      if (!res.writableEnded) ac.abort();
    });
    let out = {};
    try {
      out = await handleHookEvent(event, payload, {
        hub: this.hub,
        states: this.states,
        queues: this.queues,
        emit: (type, p) => this.onRunnerEvent(type, p),
        clientCount: () => this.clients.size,
        webActive: (id) => this.webActive(id),
        webDriving: (id) => this.webDriving(id),
        markAppPrompt: (id) => this.markAppPrompt(id),
        waitForQueued: (id, ms) => this.waitForQueued(id, ms, ac.signal),
        signal: ac.signal,
        cfg: this.cfg,
        log: this.log,
      });
    } catch (err) {
      this.log(`hook ${event} failed: ${err.message}`);
    }
    if (ac.signal.aborted) return; // nobody is listening any more
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out || {}));
  }

  // ---------- WebSocket ----------

  clientIp(req) {
    const remote = String(req.socket.remoteAddress || 'unknown');
    // Proxy headers are trusted only when the connection comes from a local connector
    // (cloudflared, tailscaled). A direct LAN / Tailscale client could forge them.
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (!loopback) return remote;
    const hdr = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return hdr && net.isIP(hdr) ? hdr : remote;
  }

  // Per-IP limit, plus a global one so forged addresses cannot buy unlimited guesses.
  tooManyFailures(ip) {
    const now = Date.now();
    const prune = (key) => {
      const list = (this.failures.get(key) || []).filter((t) => now - t < FAIL_WINDOW_MS);
      this.failures.set(key, list);
      return list.length;
    };
    return prune(ip) >= FAIL_MAX || prune('*') >= FAIL_MAX * 10;
  }

  recordFailure(ip) {
    for (const key of [ip, '*']) {
      const list = this.failures.get(key) || [];
      list.push(Date.now());
      this.failures.set(key, list);
    }
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
            sessions: this.sessionsPayload(),
            sections: this.desktop.sections,
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
      stopHoldSeconds: this.cfg.stopHoldSeconds,
      loggedIn: this.loggedIn,
      push: this.push ? { publicKey: this.push.publicKey, subscriptions: this.push.count } : null,
    };
  }

  // ---------- web activity / Stop hold ----------

  markWebActivity(sessionId, { sent = false } = {}) {
    if (!sessionId) return;
    this.webActivity.set(sessionId, Date.now());
    if (sent) this.webSends.set(sessionId, Date.now());
  }

  markAppPrompt(sessionId) {
    if (sessionId) this.appPrompts.set(sessionId, Date.now());
  }

  webActive(sessionId) {
    const t = this.webActivity.get(sessionId);
    return !!t && Date.now() - t < WEB_ACTIVE_MS;
  }

  // Is the phone the one driving this session right now? True when the last message came from
  // the web, or the web opened the session in the last few minutes and nobody typed in the app
  // since. Holding the Stop hook only then keeps the desktop app snappy when it is in use there.
  webDriving(sessionId) {
    const sent = this.webSends.get(sessionId) || 0;
    const opened = this.webActivity.get(sessionId) || 0;
    const typedInApp = this.appPrompts.get(sessionId) || 0;
    if (sent && sent > typedInApp) return true;
    return opened > typedInApp && Date.now() - opened < 5 * 60 * 1000;
  }

  // The desktop app records a user frame as soon as a prompt is submitted there, even while a
  // hook is still running: a frame newer than the hold means "the user is back at the PC".
  appTypedSince(sessionId, sinceMs) {
    const d = this.desktop.info(sessionId);
    return !!d && d.userFrameAt > sinceMs;
  }

  // Resolves true as soon as a message is queued for the session, false after `ms`, when the
  // last web client leaves (holding the terminal makes no sense then) or when the hook is gone.
  waitForQueued(sessionId, ms, signal) {
    if ((this.queues.get(sessionId) || []).length) return Promise.resolve(true);
    if (signal?.aborted) return Promise.resolve(false);
    const startedAt = Date.now();
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(poll);
        signal?.removeEventListener('abort', onAbort);
        if (this.queueWaiters.get(sessionId) === finish) this.queueWaiters.delete(sessionId);
        resolve(v);
      };
      const onAbort = () => finish(false);
      signal?.addEventListener('abort', onAbort);
      const timer = setTimeout(() => finish(false), ms);
      const poll = setInterval(() => {
        // Nobody on the web any more, or the user started typing in the app: let the turn end now.
        if (this.clients.size === 0 || this.appTypedSince(sessionId, startedAt)) finish(false);
      }, 1000);
      this.queueWaiters.get(sessionId)?.(false); // an older hold for the same session gives way
      this.queueWaiters.set(sessionId, finish);
    });
  }

  // ---------- push ----------

  async pushForRequest(request) {
    if (!this.push || !this.push.count) return;
    if (request.kind !== 'permission' && request.kind !== 'question') return;
    const meta = request.sessionId ? this.store.getMeta(request.sessionId) : null;
    const d = request.sessionId ? this.desktop.info(request.sessionId) : null;
    const title = (d?.title || meta?.title || '').slice(0, 80);
    const firstString = Object.values(request.input || {}).find((v) => typeof v === 'string');
    const detail = request.kind === 'question' ? String(request.input?.questions?.[0]?.question || '') : String(request.input?.description || request.input?.file_path || request.input?.command || firstString || '');
    await this.push.notify({
      type: 'request',
      kind: request.kind,
      requestId: request.id,
      sessionId: request.sessionId,
      toolName: request.toolName,
      session: title,
      detail: detail.split('\n')[0].slice(0, 140),
      expiresAt: request.expiresAt,
    });
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
  loadStates() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.statesFile, 'utf8'));
      const cutoff = Date.now() - 12 * 60 * 60 * 1000;
      return Object.entries(saved || {}).filter(([, s]) => s && s.source === 'hook' && new Date(s.updatedAt).getTime() > cutoff).map(([id, s]) => [id, { ...s, held: false }]);
    } catch {
      return [];
    }
  }

  persistStates() {
    clearTimeout(this.statesTimer);
    this.statesTimer = setTimeout(() => {
      try {
        const obj = {};
        for (const [id, s] of this.states) if (s.source === 'hook') obj[id] = s;
        fs.mkdirSync(path.dirname(this.statesFile), { recursive: true });
        fs.writeFileSync(this.statesFile, JSON.stringify(obj), { mode: 0o600 });
      } catch (err) {
        this.log(`cannot save session states: ${err.message}`);
      }
    }, 500);
  }

  // Does the desktop app (or a terminal) hold a process for this session? Hook state first,
  // then the process list, which also covers sessions the agent never saw emit a hook.
  async openOnPc(sessionId) {
    if (this.isLiveElsewhere(sessionId)) return true;
    const scan = await liveProcessSessions();
    return scan.ids.has(sessionId.toLowerCase());
  }

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
        return this.send(ws, { type: 'sessions', reqId, sessions: this.sessionsPayload(), sections: this.desktop.sections });
      case 'list_projects':
        return this.send(ws, { type: 'projects', reqId, projects: this.projects() });
      case 'open_session': {
        const id = String(msg.sessionId || '');
        if (!UUID_RE.test(id)) throw new Error('invalid session id');
        this.markWebActivity(id);
        const history = await this.store.loadHistory(id, {
          limit: msg.limit,
          before: UUID_RE.test(String(msg.before || '')) ? String(msg.before) : null,
          after: UUID_RE.test(String(msg.after || '')) ? String(msg.after) : null,
        });
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
          hasMore: !!history.hasMore,
          mode: history.mode,
          total: history.total,
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
          // Without a CLI login the SDK cannot resume an idle session either, so the message is
          // queued the same way and reaches Claude the next time that session runs on the PC.
          this.markWebActivity(sessionId, { sent: true });
          // Never resume with the SDK a session the PC still holds: its process would not see the
          // new turn and the conversation would fork. Such sessions always go through the hooks.
          const live = await this.openOnPc(sessionId);
          if (live || (this.loggedIn === false && hooksStatus().installed)) {
            const q = this.queues.get(sessionId) || [];
            q.push({ text, ts: new Date().toISOString() });
            this.queues.set(sessionId, q);
            this.broadcast({ type: 'queued', sessionId, count: q.length });
            const waiter = this.queueWaiters.get(sessionId);
            if (waiter) waiter(true); // a Stop hook is holding the session: deliver right now
            return this.send(ws, { type: 'ok', reqId, sessionId, delivery: 'hook', queued: q.length, live, immediate: !!waiter });
          }
        }
        if (this.loggedIn === false) {
          throw new Error(
            sessionId
              ? 'Claude Code CLI is not logged in on the PC and the hooks are not installed, so this message cannot be delivered. Run the agent with --install-hooks, or "claude login" once.'
              : 'Claude Code CLI is not logged in on the PC: run "claude login" once to start new sessions from here. Messages to existing sessions are delivered through the hooks instead.',
          );
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
      case 'push_subscribe': {
        if (!this.push) throw new Error('push is not available on this agent');
        const n = this.push.add(msg.subscription, { ua: msg.ua });
        this.log(`push: subscription added (${n} total)`);
        return this.send(ws, { type: 'ok', reqId, subscriptions: n });
      }
      case 'push_unsubscribe': {
        if (!this.push) throw new Error('push is not available on this agent');
        const n = this.push.remove(String(msg.endpoint || ''));
        return this.send(ws, { type: 'ok', reqId, subscriptions: n });
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
      if (payload.source === 'hook' || this.states.get(payload.sessionId)?.source === 'hook') this.persistStates();
      if (payload.status !== 'ended') {
        const prev = this.states.get(payload.sessionId) || {};
        this.states.set(payload.sessionId, {
          ...prev,
          status: payload.status,
          source: payload.source || prev.source,
          cwd: payload.cwd || prev.cwd || '',
          held: !!payload.held,
          staleHooks: payload.staleHooks ?? prev.staleHooks ?? false,
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
    // A turn ended in a session the web UI is using: tell the phone, even in the background.
    if ((type === 'stopped' || type === 'result') && payload.sessionId && this.webActive(payload.sessionId)) {
      const text = type === 'stopped' ? payload.lastAssistantMessage : payload.result;
      this.pushDone(payload.sessionId, typeof text === 'string' ? text : '').catch((err) => this.log(`push: ${err.message}`));
    }
    this.broadcast({ type, ...payload });
  }

  async pushDone(sessionId, text) {
    if (!this.push || !this.push.count) return;
    const meta = this.store.getMeta(sessionId);
    const d = this.desktop.info(sessionId);
    const detail = text.replace(/[#*`>_]/g, '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
    await this.push.notify({
      type: 'done',
      sessionId,
      session: (d?.title || meta?.title || '').slice(0, 80),
      detail: detail.slice(0, 160),
    });
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
