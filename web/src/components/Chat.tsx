import { useEffect, useMemo, useRef, useState } from 'react';
import type { Msg, PendingRequest, Project, SessionMeta } from '../types';
import type { T, Lang } from '../i18n';
import { collectResults, groupMessages, lastRecap, MessageGroup, planSnapshots, RecapBox } from './Messages';
import { RequestCard, type Answer } from './Requests';
import { renderMarkdown } from '../markdown';

const MODES = ['default', 'acceptEdits', 'plan'] as const;

export function Chat({ t, lang, meta, isNew, draftCwd, projects, messages, partial, loaded, truncated, status, statusSince, source, held = false, staleHooks = false, pending, queued = 0, hookOnly = false, focusRequestId, onSend, onInterrupt, onUnqueue, onAnswer }: {
  t: T;
  lang: Lang;
  statusSince?: string; // when the current status began (for the "working for 1m 20s" line)
  meta?: SessionMeta;
  isNew?: boolean;
  hookOnly?: boolean; // the PC cannot start Claude from here (no CLI login): messages always go through the hooks
  held?: boolean; // the Stop hook is holding the session for a message from here
  staleHooks?: boolean; // the session runs with older hooks: no immediate delivery until it is reopened
  focusRequestId?: string | null; // scroll to and highlight this pending request (opened from a notification)
  draftCwd?: string;
  projects?: Project[];
  messages: Msg[];
  partial: string;
  loaded: boolean;
  truncated: boolean;
  status: 'idle' | 'running' | 'waiting' | 'ended';
  source?: 'sdk' | 'hook';
  pending: PendingRequest[];
  queued?: number;
  onSend: (text: string, permissionMode: string, cwd?: string) => Promise<void>;
  onInterrupt: () => void;
  onUnqueue?: () => void;
  onAnswer: (req: PendingRequest, a: Answer) => void;
}) {
  const liveElsewhere = (source === 'hook' || hookOnly) && !isNew;
  const [text, setText] = useState('');
  const [mode, setMode] = useState<(typeof MODES)[number]>(() => {
    try {
      const m = localStorage.getItem('claude-remote:mode');
      return (MODES as readonly string[]).includes(m || '') ? (m as (typeof MODES)[number]) : 'default';
    } catch {
      return 'default';
    }
  });
  const [cwd, setCwd] = useState(draftCwd || '');
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const groups = useMemo(() => groupMessages(messages), [messages]);
  const results = useMemo(() => collectResults(messages), [messages]);
  const plans = useMemo(() => planSnapshots(messages), [messages]);
  const recap = useMemo(() => (isNew ? null : lastRecap(messages)), [messages, isNew]);
  const partialHtml = useMemo(() => (partial ? renderMarkdown(partial) : ''), [partial]);

  // Elapsed time of the current turn, ticking once a second while Claude works.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (status !== 'running') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status]);
  const elapsed = (() => {
    const start = statusSince ? new Date(statusSince).getTime() : NaN;
    if (Number.isNaN(start)) return '';
    const s = Math.max(0, Math.floor((now - start) / 1000));
    return s >= 60 ? `${Math.floor(s / 60)}min ${s % 60}s` : `${s}s`;
  })();

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, partial, pending.length, loaded]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Opened from a notification: bring the request into view once it is rendered.
  useEffect(() => {
    if (!focusRequestId) return;
    if (!pending.some((p) => p.id === focusRequestId)) return;
    const el = document.getElementById(`req-${focusRequestId}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focusRequestId, pending, loaded]);

  const submit = async () => {
    const body = text.trim();
    if (!body || busy) return;
    if (isNew && !cwd.trim()) return;
    setBusy(true);
    try {
      await onSend(body, mode, isNew ? cwd.trim() : undefined);
      setText('');
      stick.current = true;
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const changeMode = (m: (typeof MODES)[number]) => {
    setMode(m);
    try {
      localStorage.setItem('claude-remote:mode', m);
    } catch {
      /* ignore */
    }
  };

  const statusLabel = status === 'running' ? t('running') : status === 'waiting' ? t('waiting') : t('idle');

  return (
    <section className="chat">
      <div className="chat-head">
        <div className="ellipsis">
          <div className="chat-title ellipsis">{isNew ? t('newSession') : meta?.title}</div>
          <div className="muted path ellipsis">{isNew ? cwd || t('project') : meta?.cwd}</div>
        </div>
        <span className={`status ${status}`}>
          {statusLabel}
          {source === 'hook' && status !== 'idle' ? ` · ${t('liveElsewhere')}` : ''}
        </span>
      </div>

      <div className="scroll" ref={scroller} onScroll={onScroll}>
        {isNew && (
          <div className="new-session">
            <label className="field">
              <span>{t('startIn')}</span>
              <input className="input mono" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder={t('projectPlaceholder')} spellCheck={false} disabled={messages.length > 0} />
            </label>
            {projects && projects.length > 0 && messages.length === 0 && (
              <div className="projects">
                <div className="muted small">{t('recentProjects')}</div>
                {projects.slice(0, 12).map((p) => (
                  <button key={p.cwd} className={`chip ${cwd === p.cwd ? 'on' : ''} ${p.exists ? '' : 'missing'}`} onClick={() => setCwd(p.cwd)} title={p.cwd}>
                    {p.cwd}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {!loaded && !isNew && <div className="muted small pad">{t('loadingHistory')}</div>}
        {truncated && <div className="muted small pad center">{t('truncated')}</div>}
        {groups.map((g, i) => (
          <MessageGroup key={g.items[0].uuid || i} group={g} results={results} plans={plans} t={t} lang={lang} />
        ))}
        {partial && (
          <div className="msg assistant streaming">
            <div className="md" dangerouslySetInnerHTML={{ __html: partialHtml }} />
          </div>
        )}
        {status === 'running' && pending.length === 0 && (
          <div className="working">
            <span className="working-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span className="working-text">{t('workingFor')}</span>
            {elapsed && <span className="working-time">{elapsed}</span>}
          </div>
        )}
        {pending.map((p) => (
          <RequestCard key={p.id} req={p} t={t} onAnswer={(a) => onAnswer(p, a)} highlight={p.id === focusRequestId} />
        ))}
        {recap && status !== 'running' && pending.length === 0 && (
          <RecapBox
            recap={recap}
            t={t}
            onReply={(text) => {
              stick.current = true;
              onSend(text, mode).catch((err) => alert((err as Error).message));
            }}
          />
        )}
      </div>

      <div className="composer">
        {liveElsewhere && <div className="hint">{held ? t('hookDeliverNow') : status === 'idle' ? (staleHooks ? t('hookDeliverStale') : t('hookDeliverIdle')) : t('hookDeliverOnStop')}</div>}
        {queued > 0 && (
          <div className="queued">
            <span>
              {queued} {t('queuedBanner')}
            </span>
            {onUnqueue && (
              <button className="btn ghost compact" onClick={onUnqueue}>
                {t('cancelQueue')}
              </button>
            )}
          </div>
        )}
        <div className="composer-box">
          <textarea
            className="composer-input"
            rows={2}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              // Grow with the text, up to the CSS max-height.
              e.target.style.height = 'auto';
              e.target.style.height = `${e.target.scrollHeight}px`;
            }}
            onKeyDown={onKey}
            placeholder={isNew ? t('composerPlaceholderNew') : t('composerPlaceholder')}
          />
          <div className="composer-row">
            <select className="input compact" value={mode} onChange={(e) => changeMode(e.target.value as (typeof MODES)[number])} aria-label={t('permissionMode')} title={t('permissionMode')}>
              <option value="default">{t('modeDefault')}</option>
              <option value="acceptEdits">{t('modeAcceptEdits')}</option>
              <option value="plan">{t('modePlan')}</option>
            </select>
            <span className="spacer" />
            {status === 'running' && !isNew && !liveElsewhere && (
              <button className="btn danger compact" onClick={onInterrupt}>
                {t('stop')}
              </button>
            )}
            <button className="send-btn" onClick={submit} disabled={busy || !text.trim() || (isNew && !cwd.trim())} aria-label={t('send')} title={t('send')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
