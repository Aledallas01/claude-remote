// Reads the Claude desktop app's own session index so the web UI can show the same
// sidebar sections (custom groups) and titles as the Code tab. Everything here is
// optional: when the app is not installed the index stays empty and the UI falls
// back to grouping by project folder.
//
//   <data>/claude_desktop_config.json
//     preferences.epitaxyPrefs["dframe-group-scopes"][scope] = { groups, assignments, order }
//     preferences.epitaxyPrefs["dframe-code-sections"][scope] = { sections: [...] }
//     preferences.epitaxyPrefs["starred-local-code-sessions"] = [appSessionId, ...]
//   <data>/claude-code-sessions/<account>/<org>/local_<id>.json
//     { sessionId, cliSessionId, title, isArchived, cwd, ... }
//
// `cliSessionId` is the Claude Code session id, i.e. the transcript file name.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export function desktopDataDir() {
  if (process.env.CLAUDE_DESKTOP_DATA_DIR) return process.env.CLAUDE_DESKTOP_DATA_DIR;
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Claude');
}

const DEBOUNCE_MS = 1500;

export class DesktopIndex extends EventEmitter {
  constructor({ log } = {}) {
    super();
    this.log = log || (() => {});
    this.dir = desktopDataDir();
    this.configFile = path.join(this.dir, 'claude_desktop_config.json');
    this.sessionsDir = path.join(this.dir, 'claude-code-sessions');
    this.available = false;
    this.sections = []; // [{ id, name, order, collapsed }]
    this.bySession = new Map(); // cliSessionId -> { appId, title, section, archived, pinned }
    this.fileCache = new Map(); // file -> { mtimeMs, entry }
    this.watchers = [];
    this.timer = null;
    this.lastSignature = '';
  }

  async start() {
    await this.reload();
    const schedule = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.reload().catch((err) => this.log(`desktop index: ${err.message}`)), DEBOUNCE_MS);
    };
    for (const target of [this.dir, this.sessionsDir]) {
      try {
        if (!fs.existsSync(target)) continue;
        const w = fs.watch(target, { recursive: target === this.sessionsDir }, (_ev, name) => {
          if (!name) return schedule();
          const n = String(name);
          if (n === 'claude_desktop_config.json' || /^local_.*\.json$/.test(path.basename(n)) || target === this.sessionsDir) schedule();
        });
        w.on('error', () => {});
        this.watchers.push(w);
      } catch {
        /* watching is best effort */
      }
    }
  }

  stop() {
    clearTimeout(this.timer);
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    this.watchers = [];
  }

  info(cliSessionId) {
    return this.bySession.get(cliSessionId) || null;
  }

  async reload() {
    let prefs;
    try {
      const cfg = JSON.parse(await fsp.readFile(this.configFile, 'utf8'));
      prefs = cfg?.preferences?.epitaxyPrefs || {};
    } catch {
      this.setState(false, [], new Map());
      return;
    }
    const scopes = prefs['dframe-group-scopes'] || {};
    const sectionPrefs = prefs['dframe-code-sections'] || {};
    const starred = new Set(Array.isArray(prefs['starred-local-code-sessions']) ? prefs['starred-local-code-sessions'].map(String) : []);

    // Sections in sidebar order. Prefer the per-scope section layout (has order/collapsed),
    // fall back to the plain group list.
    const sections = [];
    const seen = new Set();
    const assignments = new Map(); // "code:local_x" -> group id
    for (const [scope, data] of Object.entries(scopes)) {
      const layout = sectionPrefs[scope]?.sections;
      const groups = Array.isArray(data?.groups) ? data.groups : [];
      const byId = new Map(groups.map((g) => [g.id, g]));
      if (Array.isArray(layout)) {
        for (const s of layout) {
          if (s?.kind !== 'manual' || s.shown === false || !s.id || seen.has(s.id)) continue;
          seen.add(s.id);
          sections.push({ id: s.id, name: String(s.name ?? byId.get(s.id)?.name ?? ''), order: sections.length, collapsed: !!s.collapsed });
        }
      }
      for (const g of groups) {
        if (!g?.id || seen.has(g.id)) continue;
        seen.add(g.id);
        sections.push({ id: g.id, name: String(g.name ?? ''), order: sections.length, collapsed: false });
      }
      for (const [k, v] of Object.entries(data?.assignments || {})) if (typeof v === 'string') assignments.set(k, v);
    }
    const sectionIds = new Set(sections.map((s) => s.id));

    // App session files: read only the ones that changed since last time.
    const bySession = new Map();
    const files = await this.listSessionFiles();
    const live = new Set(files);
    for (const file of files) {
      let st;
      try {
        st = await fsp.stat(file);
      } catch {
        continue;
      }
      let cached = this.fileCache.get(file);
      if (!cached || cached.mtimeMs !== st.mtimeMs) {
        let entry = null;
        try {
          const j = JSON.parse(await fsp.readFile(file, 'utf8'));
          if (j && typeof j.cliSessionId === 'string' && typeof j.sessionId === 'string') {
            entry = { appId: j.sessionId, cli: j.cliSessionId, title: typeof j.title === 'string' ? j.title.trim() : '', archived: !!j.isArchived };
          }
        } catch {
          entry = null; // partially written: picked up on the next change
        }
        cached = { mtimeMs: st.mtimeMs, entry };
        this.fileCache.set(file, cached);
      }
      const e = cached.entry;
      if (!e) continue;
      const section = assignments.get(`code:${e.appId}`) || null;
      bySession.set(e.cli, {
        appId: e.appId,
        title: e.title,
        section: section && sectionIds.has(section) ? section : null,
        archived: e.archived,
        pinned: starred.has(e.appId),
      });
    }
    for (const file of this.fileCache.keys()) if (!live.has(file)) this.fileCache.delete(file);
    this.setState(true, sections, bySession);
  }

  async listSessionFiles() {
    const out = [];
    const walk = async (dir, depth) => {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of entries) {
        const p = path.join(dir, d.name);
        if (d.isDirectory()) {
          if (depth < 3) await walk(p, depth + 1);
        } else if (/^local_.*\.json$/.test(d.name)) out.push(p);
      }
    };
    await walk(this.sessionsDir, 0);
    return out;
  }

  setState(available, sections, bySession) {
    this.available = available;
    this.sections = sections;
    this.bySession = bySession;
    const signature = JSON.stringify([available, sections, [...bySession.entries()]]);
    if (signature !== this.lastSignature) {
      const first = !this.lastSignature;
      this.lastSignature = signature;
      if (!first) this.emit('changed');
    }
  }
}
