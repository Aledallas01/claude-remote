import { useMemo, useState } from 'react';
import type { PendingRequest, SessionMeta, SessionState } from '../types';
import type { T } from '../i18n';

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
  const pendingBy = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of pending) if (p.sessionId) m.set(p.sessionId, (m.get(p.sessionId) || 0) + 1);
    return m;
  }, [pending]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle ? sessions.filter((s) => (s.title + ' ' + s.firstPrompt + ' ' + s.cwd).toLowerCase().includes(needle)) : sessions;
    // Active sessions first.
    const rank = (s: SessionMeta) => (pendingBy.has(s.id) ? 0 : states[s.id]?.status === 'running' || states[s.id]?.status === 'waiting' ? 1 : 2);
    return [...list].sort((a, b) => rank(a) - rank(b) || (a.updatedAt < b.updatedAt ? 1 : -1));
  }, [sessions, q, states, pendingBy]);

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <input className="input" placeholder={t('search')} value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn primary" onClick={onNew} title={t('newSession')}>
          ＋
        </button>
      </div>
      <div className="session-list">
        {filtered.length === 0 && <div className="muted small pad">{t('noSessions')}</div>}
        {filtered.map((s) => {
          const st = states[s.id];
          const n = pendingBy.get(s.id) || 0;
          const dot = n ? 'waiting' : st?.status || '';
          return (
            <button key={s.id} className={`session ${current === s.id ? 'active' : ''}`} onClick={() => onSelect(s.id)}>
              <div className="session-row">
                <span className={`dot ${dot}`} />
                <span className="session-title ellipsis">{s.title}</span>
                {n > 0 && <span className="badge warn">{n}</span>}
                <span className="muted small time">{relTime(s.updatedAt)}</span>
              </div>
              <div className="session-sub ellipsis">
                <span className="proj">{projectName(s.cwd)}</span>
                {s.gitBranch && s.gitBranch !== 'HEAD' && <span className="muted"> · {s.gitBranch}</span>}
                {st?.source === 'hook' && st.status !== 'ended' && <span className="muted"> · {t('liveElsewhere')}</span>}
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
