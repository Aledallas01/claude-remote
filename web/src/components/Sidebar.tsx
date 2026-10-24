import { useMemo, useState } from 'react';
import type { PendingRequest, SessionMeta, SessionState } from '../types';
import type { T } from '../i18n';

type GroupBy = 'project' | 'time';
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

// Time buckets, oldest boundary first so the first match wins.
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
}

export function Sidebar({ t, sessions, states, pending, current, onSelect, onNew }: {
  t: T;
  sessions: SessionMeta[];
  states: Record<string, SessionState>;
  pending: PendingRequest[];
  current: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const [q, setQ] = useState('');
  const [groupBy, setGroupBy] = useState<GroupBy>(() => (loadJson<string>(GROUP_KEY, 'project') === 'time' ? 'time' : 'project'));
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => loadJson(COLLAPSED_KEY, {}));

  const pendingBy = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of pending) if (p.sessionId) m.set(p.sessionId, (m.get(p.sessionId) || 0) + 1);
    return m;
  }, [pending]);

  const rank = (s: SessionMeta) => (pendingBy.has(s.id) ? 0 : states[s.id]?.status === 'running' || states[s.id]?.status === 'waiting' ? 1 : 2);

  const sections = useMemo<Section[]>(() => {
    const needle = q.trim().toLowerCase();
    const list = needle ? sessions.filter((s) => (s.title + ' ' + s.firstPrompt + ' ' + s.cwd).toLowerCase().includes(needle)) : sessions;
    const sorted = [...list].sort((a, b) => rank(a) - rank(b) || (a.updatedAt < b.updatedAt ? 1 : -1));
    const map = new Map<string, Section & { order: number; latest: string }>();
    const now = Date.now();
    for (const s of sorted) {
      let key: string;
      let label: string;
      let sub: string | undefined;
      let order = 0;
      if (groupBy === 'project') {
        key = `p:${s.cwd.toLowerCase()}`;
        label = projectName(s.cwd);
        sub = s.cwd;
      } else {
        const b = timeBucket(s.updatedAt, now);
        key = `t:${b.key}`;
        label = t(b.key as 'today' | 'yesterday' | 'last7' | 'last30' | 'older');
        order = b.order;
      }
      let sec = map.get(key);
      if (!sec) {
        sec = { key, label, sub, sessions: [], attention: 0, order, latest: s.updatedAt };
        map.set(key, sec);
      }
      sec.sessions.push(s);
      if (rank(s) < 2) sec.attention += 1;
      if (s.updatedAt > sec.latest) sec.latest = s.updatedAt;
    }
    const out = [...map.values()];
    if (groupBy === 'project') out.sort((a, b) => (b.attention > 0 ? 1 : 0) - (a.attention > 0 ? 1 : 0) || (a.latest < b.latest ? 1 : -1));
    else out.sort((a, b) => a.order - b.order);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, q, states, pendingBy, groupBy, t]);

  const toggle = (key: string) => {
    setCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      saveJson(COLLAPSED_KEY, next);
      return next;
    });
  };
  const changeGroup = (g: GroupBy) => {
    setGroupBy(g);
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
          <button role="tab" aria-selected={groupBy === 'project'} className={groupBy === 'project' ? 'on' : ''} onClick={() => changeGroup('project')}>
            {t('byProject')}
          </button>
          <button role="tab" aria-selected={groupBy === 'time'} className={groupBy === 'time' ? 'on' : ''} onClick={() => changeGroup('time')}>
            {t('byDate')}
          </button>
        </div>
      </div>
      <div className="session-list">
        {sections.length === 0 && <div className="muted small pad">{t('noSessions')}</div>}
        {sections.map((sec) => {
          const open = searching || !collapsed[sec.key] || sec.sessions.some((s) => s.id === current && pendingBy.has(s.id));
          return (
            <div className="group" key={sec.key}>
              <button className={`group-head ${open ? 'open' : ''}`} onClick={() => toggle(sec.key)} title={sec.sub || sec.label}>
                <span className="group-chev">▸</span>
                <span className="group-label ellipsis">{sec.label}</span>
                {sec.attention > 0 && <span className="dot waiting" />}
                <span className="group-count">{sec.sessions.length}</span>
              </button>
              {open &&
                sec.sessions.map((s) => {
                  const st = states[s.id];
                  const n = pendingBy.get(s.id) || 0;
                  const dot = n ? 'waiting' : st?.status || '';
                  const live = st?.source === 'hook' && st.status !== 'ended';
                  return (
                    <button key={s.id} className={`session ${current === s.id ? 'active' : ''}`} onClick={() => onSelect(s.id)}>
                      <div className="session-row">
                        <span className={`dot ${dot}`} />
                        <span className="session-title ellipsis">{s.title}</span>
                        {n > 0 && <span className="badge warn">{n}</span>}
                        <span className="muted small time">{relTime(s.updatedAt)}</span>
                      </div>
                      {(groupBy === 'time' || s.gitBranch || live) && (
                        <div className="session-sub ellipsis">
                          {groupBy === 'time' && <span className="proj">{projectName(s.cwd)}</span>}
                          {s.gitBranch && s.gitBranch !== 'HEAD' && <span className="muted">{groupBy === 'time' ? ' · ' : ''}{s.gitBranch}</span>}
                          {live && <span className="muted">{groupBy === 'time' || s.gitBranch ? ' · ' : ''}{t('liveElsewhere')}</span>}
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
