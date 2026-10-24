// Claude Code hook integration.
//  - install/uninstall hook entries in ~/.claude/settings.json
//  - handle hook events forwarded by hook/claude-remote-hook.js
// Hooks make sessions started in a terminal / the desktop app visible and
// answerable from the web UI. They fail open: if the agent is not running,
// the hook script exits immediately and Claude Code behaves as usual.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_DIR } from './transcripts.js';

const MARKER = 'claude-remote-hook.js';
const EVENTS_SHORT = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'Notification'];

export function hookScriptPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'hook', MARKER);
}

export function settingsPath() {
  return path.join(CLAUDE_DIR, 'settings.json');
}

function q(p) {
  return `"${p.replace(/\\/g, '/')}"`;
}

function hookCommand(event) {
  return `${q(process.execPath)} ${q(hookScriptPath())} ${event}`;
}

function readSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`cannot parse ${settingsPath()}: ${err.message}`);
  }
}

function writeSettings(settings) {
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(file, `${file}.bak-${stamp}`);
  }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function isOurs(entry) {
  return Array.isArray(entry?.hooks) && entry.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(MARKER));
}

function stripOurs(hooks) {
  const out = {};
  for (const [event, entries] of Object.entries(hooks || {})) {
    if (!Array.isArray(entries)) {
      out[event] = entries;
      continue;
    }
    const kept = entries.filter((e) => !isOurs(e));
    if (kept.length) out[event] = kept;
  }
  return out;
}

export function hooksStatus() {
  try {
    const settings = readSettings();
    const hooks = settings.hooks || {};
    const events = Object.entries(hooks)
      .filter(([, entries]) => Array.isArray(entries) && entries.some(isOurs))
      .map(([event]) => event);
    return { installed: events.includes('PermissionRequest'), events };
  } catch (err) {
    return { installed: false, events: [], error: err.message };
  }
}

export function installHooks(cfg) {
  const settings = readSettings();
  const hooks = stripOurs(settings.hooks);
  const longTimeout = Math.max(30, Number(cfg.hookWaitSeconds || 180) + 20);
  const add = (event, entry) => {
    hooks[event] = [...(hooks[event] || []), entry];
  };
  for (const ev of EVENTS_SHORT) {
    add(ev, { hooks: [{ type: 'command', command: hookCommand(ev), timeout: 10 }] });
  }
  add('PermissionRequest', { hooks: [{ type: 'command', command: hookCommand('PermissionRequest'), timeout: longTimeout }] });
  add('PreToolUse', {
    matcher: 'AskUserQuestion',
    hooks: [{ type: 'command', command: hookCommand('PreToolUse'), timeout: longTimeout }],
  });
  settings.hooks = hooks;
  writeSettings(settings);
  return hooksStatus();
}

export function uninstallHooks() {
  const settings = readSettings();
  const hooks = stripOurs(settings.hooks);
  if (Object.keys(hooks).length) settings.hooks = hooks;
  else delete settings.hooks;
  writeSettings(settings);
  return hooksStatus();
}

// ---------- event handling ----------

// ctx: { hub, states, emit, clientCount, cfg, log }
export async function handleHookEvent(event, payload, ctx) {
  const sessionId = typeof payload?.session_id === 'string' ? payload.session_id : '';
  const cwd = typeof payload?.cwd === 'string' ? payload.cwd : '';
  const touch = (status, extra = {}) => {
    if (!sessionId) return;
    ctx.states.set(sessionId, {
      status,
      source: 'hook',
      cwd,
      transcriptPath: payload.transcript_path,
      updatedAt: new Date().toISOString(),
      ...extra,
    });
    ctx.emit('status', { sessionId, status, source: 'hook', cwd });
  };

  switch (event) {
    case 'SessionStart':
      touch('idle', { startedAt: new Date().toISOString(), model: payload.model });
      return {};
    case 'SessionEnd':
      if (sessionId) {
        ctx.states.delete(sessionId);
        if (ctx.queues?.delete(sessionId)) ctx.emit('queued', { sessionId, count: 0 });
        ctx.hub.cancelForSession(sessionId, 'session_ended');
        ctx.emit('status', { sessionId, status: 'ended', source: 'hook', cwd });
      }
      return {};
    case 'UserPromptSubmit': {
      touch('running');
      ctx.emit('prompt_submitted', { sessionId, cwd, prompt: String(payload.prompt || '').slice(0, 2000) });
      // Messages sent from the web while the user was away ride along as extra context.
      const queued = takeQueued(ctx, sessionId);
      if (!queued) return {};
      return {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: `The user also sent the following message(s) from Claude Remote (web) before this prompt. Treat them as part of the user's instructions:\n\n${queued}`,
        },
      };
    }
    case 'Stop': {
      ctx.emit('stopped', { sessionId, cwd, lastAssistantMessage: String(payload.last_assistant_message || '').slice(0, 4000) });
      // A message queued from the web is delivered as the next instruction: blocking the stop
      // with a reason makes Claude continue with that text, using the session's own credentials.
      const queued = takeQueued(ctx, sessionId);
      if (queued) {
        touch('running');
        return { decision: 'block', reason: `The user sent this message from Claude Remote (web). Continue with it as the next instruction:\n\n${queued}` };
      }
      touch('idle');
      return {};
    }
    case 'Notification':
      ctx.emit('notification', {
        sessionId,
        cwd,
        title: payload.title || '',
        message: String(payload.message || '').slice(0, 1000),
        notificationType: payload.notification_type || '',
      });
      if (payload.notification_type === 'idle_prompt') touch('idle');
      return {};
    case 'PermissionRequest':
      return permissionFromHook(payload, sessionId, cwd, touch, ctx);
    case 'PreToolUse':
      if (payload?.tool_name === 'AskUserQuestion') return questionFromHook(payload, sessionId, cwd, touch, ctx);
      return {};
    default:
      return {};
  }
}

// Pops every message queued for the session and returns them as one text (or '' when none).
function takeQueued(ctx, sessionId) {
  if (!sessionId || !ctx.queues) return '';
  const q = ctx.queues.get(sessionId);
  if (!q || !q.length) return '';
  ctx.queues.delete(sessionId);
  ctx.emit('queued', { sessionId, count: 0 });
  ctx.emit('delivered', { sessionId, count: q.length });
  return q.map((m) => m.text).join('\n\n---\n\n');
}

async function permissionFromHook(payload, sessionId, cwd, touch, ctx) {
  if (ctx.clientCount() === 0) return {}; // nobody watching: leave the terminal prompt alone
  const waitMs = Math.max(5, Number(ctx.cfg.hookWaitSeconds || 180)) * 1000;
  const { promise } = ctx.hub.create({
    sessionId,
    cwd,
    kind: 'permission',
    toolName: payload.tool_name,
    input: payload.tool_input ?? {},
    suggestions: payload.permission_suggestions || [],
    source: 'hook',
    timeoutMs: waitMs,
  });
  touch('waiting');
  const answer = await promise;
  touch('running');
  if (!answer || answer.release) return {}; // timeout / handed back to the terminal
  if (answer.behavior === 'allow') {
    const decision = { behavior: 'allow', updatedInput: payload.tool_input ?? {} };
    if (answer.always && Array.isArray(payload.permission_suggestions) && payload.permission_suggestions.length) {
      decision.updatedPermissions = payload.permission_suggestions;
    }
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'deny', message: answer.message?.trim() || 'The user denied this action from Claude Remote.' },
    },
  };
}

async function questionFromHook(payload, sessionId, cwd, touch, ctx) {
  if (ctx.clientCount() === 0) return {};
  const waitMs = Math.max(5, Number(ctx.cfg.hookWaitSeconds || 180)) * 1000;
  const input = payload.tool_input ?? {};
  const { promise } = ctx.hub.create({
    sessionId,
    cwd,
    kind: 'question',
    toolName: 'AskUserQuestion',
    input,
    suggestions: [],
    source: 'hook',
    timeoutMs: waitMs,
  });
  touch('waiting');
  const answer = await promise;
  touch('running');
  if (!answer || answer.release || !answer.answers) return {};
  const updatedInput = { questions: input.questions, answers: answer.answers };
  if (answer.response) updatedInput.response = answer.response;
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput },
  };
}
