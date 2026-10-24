// WebSocket client for the Claude Remote agent, with reconnect and request/response.
import type { Connection } from './types';

export type ConnStatus = 'disconnected' | 'connecting' | 'connected' | 'unauthorized';

type Listener = (msg: any) => void;

export class AgentClient {
  private ws: WebSocket | null = null;
  private conn: Connection | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<(s: ConnStatus, detail?: string) => void>();
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: number }>();
  private reqSeq = 1;
  private retry = 0;
  private retryTimer: number | null = null;
  private manualClose = false;
  status: ConnStatus = 'disconnected';

  onMessage(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onStatus(fn: (s: ConnStatus, detail?: string) => void) {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  private setStatus(s: ConnStatus, detail?: string) {
    this.status = s;
    for (const fn of this.statusListeners) fn(s, detail);
  }

  connect(conn: Connection) {
    this.conn = conn;
    this.manualClose = false;
    this.retry = 0;
    this.open();
  }

  private open() {
    if (!this.conn) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.setStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.conn.url.replace(/\/$/, '') + '/ws');
    } catch (err) {
      this.setStatus('disconnected', (err as Error).message);
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token: this.conn!.token }));
    };
    ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'hello') {
        this.retry = 0;
        this.setStatus('connected');
      }
      if (msg.reqId && this.waiting.has(msg.reqId)) {
        const w = this.waiting.get(msg.reqId)!;
        this.waiting.delete(msg.reqId);
        clearTimeout(w.timer);
        if (msg.type === 'error') w.reject(new Error(msg.message || 'error'));
        else w.resolve(msg);
        if (msg.type === 'error' || msg.type === 'ok') return;
      }
      for (const fn of this.listeners) fn(msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const w of this.waiting.values()) {
        clearTimeout(w.timer);
        w.reject(new Error('disconnected'));
      }
      this.waiting.clear();
      if (ev.code === 4003 || ev.code === 4029) {
        this.setStatus('unauthorized', ev.code === 4029 ? 'too many failed attempts' : ev.reason || 'invalid token');
        return;
      }
      this.setStatus('disconnected', ev.reason || `code ${ev.code}`);
      if (!this.manualClose) this.scheduleRetry();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleRetry() {
    if (this.retryTimer || this.manualClose) return;
    const delay = Math.min(15000, 1000 * Math.pow(2, this.retry++));
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
  }

  reconnectNow() {
    if (this.status === 'connected' || this.status === 'connecting') return;
    this.retry = 0;
    this.open();
  }

  close() {
    this.manualClose = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.ws?.close(1000, 'bye');
    this.ws = null;
    this.setStatus('disconnected');
  }

  send(obj: Record<string, unknown>) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('not connected');
    this.ws.send(JSON.stringify(obj));
  }

  request<T = any>(obj: Record<string, unknown>, timeoutMs = 30000): Promise<T> {
    const reqId = this.reqSeq++;
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.waiting.delete(reqId);
        reject(new Error('timeout'));
      }, timeoutMs);
      this.waiting.set(reqId, { resolve, reject, timer });
      try {
        this.send({ ...obj, reqId });
      } catch (err) {
        clearTimeout(timer);
        this.waiting.delete(reqId);
        reject(err as Error);
      }
    });
  }
}

// ---------- connection persistence ----------

const KEY = 'claude-remote:connection';

// Messaging apps and phone keyboards like to replace '-' with en/em dashes and '_' with
// look-alikes, and may add zero-width characters. Undo that: the token only uses [A-Za-z0-9_-].
export function normalizeToken(t: string): string {
  return t
    .replace(/[​-‍﻿\s]/g, '')
    .replace(/[‐-―−⁃﹘﹣－]/g, '-')
    .replace(/[‗＿]/g, '_');
}

// Some scanners / messaging apps re-encode or wrap links; decode until stable.
function deepDecode(s: string): string {
  let cur = s;
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(cur);
      if (next === cur) break;
      cur = next;
    } catch {
      break;
    }
  }
  return cur;
}

export function parseLink(input: string): Connection | null {
  let s = input.trim().replace(/^[<"'(\[]+|[>"')\].,;]+$/g, '');
  if (!s) return null;
  let hash = s;
  const idx = s.indexOf('#');
  if (idx >= 0) hash = s.slice(idx + 1);
  else if (/^\/?[?&]?a=/.test(hash)) hash = hash.replace(/^\/?[?&]/, '');
  hash = hash.replace(/^[?&]/, '');
  if (!/(^|&)a=/.test(hash) && /%26a%3D|%23a%3D/i.test(hash)) hash = deepDecode(hash).replace(/^.*#/, '');
  const p = new URLSearchParams(hash);
  const a = p.get('a') ? deepDecode(p.get('a')!.trim()) : '';
  const t = normalizeToken(p.get('t') || '');
  if (a && t && /^wss?:\/\//.test(a)) return { url: normalizeToken(a).replace(/\/+$/, ''), token: t, name: p.get('n') || undefined };
  return null;
}

export function loadConnection(): Connection | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (c && typeof c.url === 'string' && typeof c.token === 'string') return c;
  } catch {
    /* ignore */
  }
  return null;
}

export function saveConnection(c: Connection | null) {
  try {
    if (c) localStorage.setItem(KEY, JSON.stringify(c));
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode */
  }
}

export function normalizeAgentUrl(input: string): string {
  let s = input.trim().replace(/\/+$/, '');
  if (!s) return s;
  if (/^https?:\/\//.test(s)) s = s.replace(/^http/, 'ws');
  else if (!/^wss?:\/\//.test(s)) {
    const local = /^(localhost|127\.0\.0\.1|\[::1\]|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(s);
    s = (local ? 'ws://' : 'wss://') + s;
  }
  return s;
}
