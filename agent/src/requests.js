// Pending user-input requests (tool permissions and AskUserQuestion),
// coming either from the Agent SDK (canUseTool) or from Claude Code hooks.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

export class RequestHub extends EventEmitter {
  constructor() {
    super();
    this.pending = new Map(); // id -> request
  }

  list() {
    return [...this.pending.values()].map(publicRequest);
  }

  // Creates a request and returns a promise resolved with the user's answer
  // ({ behavior, always, message, answers, release }) or null on timeout.
  create({ sessionId, cwd, kind, toolName, input, suggestions, source, timeoutMs }) {
    const id = crypto.randomUUID();
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    const req = {
      id,
      sessionId,
      cwd,
      kind, // 'permission' | 'question'
      toolName,
      input,
      suggestions: suggestions || [],
      source, // 'sdk' | 'hook'
      createdAt: new Date().toISOString(),
      expiresAt: timeoutMs ? new Date(Date.now() + timeoutMs).toISOString() : null,
      resolve,
      timer: null,
    };
    if (timeoutMs) {
      req.timer = setTimeout(() => this.finish(id, null, 'timeout'), timeoutMs);
    }
    this.pending.set(id, req);
    this.emit('created', publicRequest(req));
    return { id, promise };
  }

  finish(id, answer, reason = 'answered') {
    const req = this.pending.get(id);
    if (!req) return false;
    if (req.timer) clearTimeout(req.timer);
    this.pending.delete(id);
    this.emit('resolved', { id, sessionId: req.sessionId, reason });
    req.resolve(answer);
    return true;
  }

  cancelForSession(sessionId, reason = 'cancelled') {
    for (const req of [...this.pending.values()]) {
      if (req.sessionId === sessionId) this.finish(req.id, null, reason);
    }
  }
}

function publicRequest(r) {
  return {
    id: r.id,
    sessionId: r.sessionId,
    cwd: r.cwd,
    kind: r.kind,
    toolName: r.toolName,
    input: r.input,
    suggestions: r.suggestions,
    source: r.source,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
  };
}
