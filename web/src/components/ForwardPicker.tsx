import { useEffect, useMemo, useState } from 'react';
import type { SessionMeta, SessionState } from '../types';
import type { T } from '../i18n';

function projectName(cwd: string) {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}

// Modal list of chats to forward a message to. Live chats first, then by recency.
export function ForwardPicker({ t, sessions, states, exclude, preview, onPick, onNew, onClose }: {
  t: T;
  sessions: SessionMeta[];
  states: Record<string, SessionState>;
  exclude?: string | null;
  preview: string;
  onPick: (sessionId: string) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rank = (s: SessionMeta) => (states[s.id]?.status === 'running' || states[s.id]?.status === 'waiting' ? 0 : states[s.id] ? 1 : 2);
    return sessions
      .filter((s) => s.id !== exclude && !s.archived)
      .filter((s) => !needle || (s.title + ' ' + s.cwd).toLowerCase().includes(needle))
      .sort((a, b) => rank(a) - rank(b) || (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, 60);
  }, [sessions, states, exclude, q]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label={t('forwardTo')} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>{t('forwardTo')}</strong>
          <button className="btn ghost compact" type="button" onClick={onClose} aria-label={t('cancelQueue')}>
            ×
          </button>
        </div>
        <div className="fwd-preview muted small">{preview}</div>
        <input className="input" autoFocus placeholder={t('search')} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="picker-list">
          <button type="button" className="picker-item new" onClick={onNew}>
            <span className="plus">+</span>
            <span className="picker-title">{t('newSessionTarget')}</span>
          </button>
          {list.map((s) => {
            const st = states[s.id];
            const dot = st?.status || '';
            return (
              <button type="button" key={s.id} className="picker-item" onClick={() => onPick(s.id)}>
                <span className={`dot ${dot}`} />
                <span className="picker-main">
                  <span className="picker-title ellipsis">{s.title}</span>
                  <span className="picker-sub ellipsis">
                    <span className="proj">{projectName(s.cwd)}</span>
                    {st && st.status !== 'ended' && <span className="muted"> · {t('liveElsewhere')}</span>}
                  </span>
                </span>
              </button>
            );
          })}
          {list.length === 0 && <div className="muted small pad">{t('noSessions')}</div>}
        </div>
      </div>
    </div>
  );
}
