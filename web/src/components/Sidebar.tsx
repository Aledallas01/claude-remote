import { useMemo, useState } from 'react';
import type { PendingRequest, SessionMeta, SessionState, SidebarSection } from '../types';
import type { T } from '../i18n';

// 'app' mirrors the sections of the Claude desktop app's Code tab (available when the
// agent runs next to the app); 'project' and 'time' are computed here.
type GroupBy = 'app' | 'project' | 'time';
const GROUP_KEY = 'claude-remote:groupBy';
const COLLAPSED_KEY = 'claude-remote:collapsed';

function projectName(cwd: string) {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}

function relTime(iso: string) {
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return '';
  const diff = Math.max(0, Date.now() - d);
  const m = Math.round(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function loadJson<V>(key: string, fallback: V): V {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as V) : fallback;
  } catch {
    return fallback;
  }
}
function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

function timeBucket(iso: string, now: number): { key: string; order: number } {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return { key: 'older', order: 4 };
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  const day = 86400000;
  if (t >= today) return { key: 'today', order: 0 };
  if (t >= today - day) return { key: 'yesterday', order: 1 };
  if (t >= today - 7 * day) return { key: 'last7', order: 2 };
  if (t >= today - 30 * day) return { key: 'last30', order: 3 };
  return { key: 'older', order: 4 };
}

interface Section {
  key: string;
  label: string;
  sub?: string;
  sessions: SessionMeta[];
  attention: number; // sessions waiting for the user or running
  defaultCollapsed: boolean;
  mono?: boolean;
}

export function Sidebar({ t, sessions, sections, states, pending, current, onSelect, onNew }: {
  t: T;
  sessions: SessionMeta[];
  sections: SidebarSection[];
  states: Record<string, SessionState>;
  pending: PendingRequest[];
  current: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const [q, setQ] = useState('');
  const hasApp = sections.length > 0;
  const [groupPref, setGroupPref] = useState<GroupBy>(() => {
    const v = loadJson<string>(GROUP_KEY, 'app');
    return v === 'time' || v === 'project' || v === 'app' ? v : 'app';
  });
  const groupBy: GroupBy = groupPref === 'app' && !hasApp ? 'project' : groupPref;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => loadJson(COLLAPSED_KEY, {}));

  const pendingBy = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of pending) if (p.sessionId) m.set(p.sessionId, (m.get(p.sessionId) || 0) + 1);
    return m;
  }, [pending]);

  const rank = (s: SessionMeta) => (pendingBy.has(s.id) ? 0 : states[s.id]?.status === 'running' || states[s.id]?.status === 'waiting' ? 1 : 2);

  const built = useMemo<Section[]>(() => {
    const needle = q.trim().toLowerCase();
    const visible = sessions.filter((s) => !s.archived);
    const list = needle ? visible.filter((s) => (s.title + ' ' + s.firstPrompt + ' ' + s.cwd).toLowerCase().includes(needle)) : visible;
    const sorted = [...list].sort((a, b) => rank(a) - rank(b) || (a.updatedAt < b.updatedAt ? 1 : -1));
    const map = new Map<string, Section & { order: number; latest: string }>();
    const now = Date.now();
    const add = (key: string, s: SessionMeta, make: () => Omit<Section, 'key' | 'sessions' | 'attention'> & { order: number }) => {
      let sec = map.get(key);
      if (!sec) {
        const base = make();
        sec = { key, sessions: [], attention: 0, latest: s.updatedAt, ...base };
        map.set(key, sec);
      }
      sec.sessions.push(s);
      if (rank(s) < 2) sec.attention += 1;
      if (s.updatedAt > sec.latest) sec.latest = s.updatedAt;
    };
    const appIndex = new Map(sections.map((sec, i) => [sec.id, { ...sec, i }]));
    for (const s of sorted) {
      if (groupBy === 'app') {
        if (s.pinned) add('pinned', s, () => ({ label: t('pinned'), order: -1, defaultCollapsed: false }));
        const sec = s.section ? appIndex.get(s.section) : undefined;
        if (sec) add(`a:${sec.id}`, s, () => ({ label: sec.name, order: sec.i, defaultCollapsed: sec.collapsed }));
        else add('unsorted', s, () => ({ label: t('unsorted'), order: 1e6, defaultCollapsed: false }));
      } else if (groupBy === 'project') {
        add(`p:${s.cwd.toLowerCase()}`, s, () => ({ label: projectName(s.cwd), sub: s.cwd, order: 0, defaultCollapsed: false, mono: true }));
      } else {
        const b = timeBucket(s.updatedAt, now);
        add(`t:${b.key}`, s, () => ({ label: t(b.key as 'today' | 'yesterday' | 'last7' | 'last30' | 'older'), order: b.order, defaultCollapsed: false }));
      }
    }
    const out = [...map.values()];
    if (groupBy === 'project') out.sort((a, b) => (b.attention > 0 ? 1 : 0) - (a.attention > 0 ? 1 : 0) || (a.latest < b.latest ? 1 : -1));
    else out.sort((a, b) => a.order - b.order);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, sections, q, states, pendingBy, groupBy, t]);

  const toggle = (key: string, isOpen: boolean) => {
    setCollapsed((prev) => {
      const next = { ...prev, [key]: isOpen };
      saveJson(COLLAPSED_KEY, next);
      return next;
    });
  };
  const changeGroup = (g: GroupBy) => {
    setGroupPref(g);
    saveJson(GROUP_KEY, g);
  };

  const searching = q.trim().length > 0;

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <button className="btn primary new-btn" onClick={onNew}>
          <span className="plus">+</span>
          {t('newSession')}
        </button>
        <input className="input" placeholder={t('search')} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="seg" role="tablist" aria-label={t('groupBy')}>
          {hasApp && (
            <button role="tab" aria-selected={groupBy === 'app'} className={groupBy === 'app' ? 'on' : ''} onClick={() => changeGroup('app')}>
              {t('byApp')}
            </button>
          )}
          <button role="tab" aria-selected={groupBy === 'project'} className={groupBy === 'project' ? 'on' : ''} onClick={() => changeGroup('project')}>
            {t('byProject')}
          </button>
          <button role="tab" aria-selected={groupBy === 'time'} className={groupBy === 'time' ? 'on' : ''} onClick={() => changeGroup('time')}>
            {t('byDate')}
          </button>
        </div>
      </div>
      <div className="session-list">
        {built.length === 0 && <div className="muted small pad">{t('noSessions')}</div>}
        {built.map((sec) => {
          const isCollapsed = collapsed[sec.key] ?? sec.defaultCollapsed;
          const open = searching || !isCollapsed || sec.sessions.some((s) => s.id === current || pendingBy.has(s.id));
          const showProject = groupBy !== 'project';
          return (
            <div className="group" key={sec.key}>
              <button className={`group-head ${open ? 'open' : ''}`} onClick={() => toggle(sec.key, open)} title={sec.sub || sec.label}>
                <span className="group-chev">▸</span>
                <span className={`group-label ellipsis ${sec.mono ? 'mono' : ''}`}>{sec.label}</span>
                {sec.attention > 0 && <span className="dot waiting" />}
                <span className="group-count">{sec.sessions.length}</span>
              </button>
              {open &&
                sec.sessions.map((s) => {
                  const st = states[s.id];
                  const n = pendingBy.get(s.id) || 0;
                  const dot = n ? 'waiting' : st?.status || '';
                  const live = st?.source === 'hook' && st.status !== 'ended';
                  const parts: React.ReactNode[] = [];
                  if (showProject) parts.push(<span key="p" className="proj">{projectName(s.cwd)}</span>);
                  if (s.gitBranch && s.gitBranch !== 'HEAD') parts.push(<span key="b" className="muted">{s.gitBranch}</span>);
                  if (live) parts.push(<span key="l" className="muted">{t('liveElsewhere')}</span>);
                  return (
                    <button key={`${sec.key}:${s.id}`} className={`session ${current === s.id ? 'active' : ''}`} onClick={() => onSelect(s.id)}>
                      <div className="session-row">
                        <span className={`dot ${dot}`} />
                        <span className="session-title ellipsis">{s.title}</span>
                        {n > 0 && <span className="badge warn">{n}</span>}
                        <span className="muted small time">{relTime(s.updatedAt)}</span>
                      </div>
                      {parts.length > 0 && (
                        <div className="session-sub ellipsis">
                          {parts.map((p, i) => (
                            <span key={i}>
                              {i > 0 && <span className="muted"> · </span>}
                              {p}
                            </span>
                          ))}
                        </div>
                      )}
                    </button>
                  );
                })}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
