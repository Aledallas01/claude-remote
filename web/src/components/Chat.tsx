import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Attachment, Msg, PendingRequest, Project, SessionMeta } from '../types';

const MAX_ATTACHMENTS = 4;
const MAX_EDGE = 1600;

// Resizes a picked image on the device (phones produce 4000px photos) and returns JPEG base64.
async function prepareImage(file: File): Promise<Attachment> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
    return { name: file.name, type: file.type || 'image/jpeg', data: dataUrl.split(',')[1] || '', url: dataUrl };
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const keepPng = file.type === 'image/png' && file.size < 1_500_000; // screenshots with text stay sharp
  const type = keepPng ? 'image/png' : 'image/jpeg';
  const url = canvas.toDataURL(type, 0.85);
  return { name: file.name.replace(/\.[^.]+$/, '') + (keepPng ? '.png' : '.jpg'), type, data: url.split(',')[1] || '', url };
}
import type { T, Lang } from '../i18n';
import { collectResults, groupMessages, lastRecap, MessageGroup, planSnapshots, RecapBox } from './Messages';
import { RequestCard, type Answer } from './Requests';
import { renderMarkdown } from '../markdown';

const MODES = ['default', 'acceptEdits', 'plan'] as const;

export function Chat({ t, lang, meta, isNew, draftCwd, draftText, projects, messages, partial, loaded, truncated, loadingOlder = false, onLoadOlder, status, statusSince, source, held = false, staleHooks = false, pending, queued = 0, hookOnly = false, focusRequestId, onSend, onInterrupt, onUnqueue, onAnswer, onForward }: {
  t: T;
  lang: Lang;
  draftText?: string; // text to start the composer with (forwarded message into a new session)
  onForward?: (text: string) => void;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
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
  onSend: (text: string, permissionMode: string, cwd?: string, images?: Attachment[]) => Promise<void>;
  onInterrupt: () => void;
  onUnqueue?: () => void;
  onAnswer: (req: PendingRequest, a: Answer) => void;
}) {
  const liveElsewhere = (source === 'hook' || hookOnly) && !isNew;
  const [text, setText] = useState(draftText || '');
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

  // After older messages are prepended, keep what the user was reading in place.
  const prependAnchor = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || prependAnchor.current === null) return;
    el.scrollTop = el.scrollHeight - prependAnchor.current;
    prependAnchor.current = null;
  }, [messages]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current && prependAnchor.current === null) el.scrollTop = el.scrollHeight;
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

  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    const picked = Array.from(files).filter((f) => f.type.startsWith('image/')).slice(0, MAX_ATTACHMENTS - attachments.length);
    const prepared = await Promise.all(picked.map(prepareImage));
    setAttachments((a) => [...a, ...prepared].slice(0, MAX_ATTACHMENTS));
  };

  const submit = async () => {
    const body = text.trim();
    if ((!body && attachments.length === 0) || busy) return;
    if (isNew && !cwd.trim()) return;
    setBusy(true);
    try {
      await onSend(body, mode, isNew ? cwd.trim() : undefined, attachments.length ? attachments : undefined);
      setText('');
      setAttachments([]);
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
        {truncated && loaded && (
          <div className="center">
            <button
              className="btn compact"
              disabled={loadingOlder}
              onClick={() => {
                const el = scroller.current;
                prependAnchor.current = el ? el.scrollHeight - el.scrollTop : null;
                onLoadOlder?.();
              }}
            >
              {loadingOlder ? t('loadingHistory') : t('loadOlder')}
            </button>
          </div>
        )}
        {groups.map((g, i) => (
          <MessageGroup key={g.items[0].uuid || i} group={g} results={results} plans={plans} t={t} lang={lang} onForward={onForward} />
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
          {attachments.length > 0 && (
            <div className="attach-strip">
              {attachments.map((a, i) => (
                <div key={i} className="attach-thumb">
                  <img src={a.url} alt={a.name} />
                  <button type="button" className="attach-remove" aria-label={t('removeAttachment')} onClick={() => setAttachments((list) => list.filter((_, k) => k !== i))}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
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
            <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => addFiles(e.target.files).then(() => { if (fileInput.current) fileInput.current.value = ''; })} />
            <button type="button" className="icon-round" onClick={() => fileInput.current?.click()} disabled={attachments.length >= MAX_ATTACHMENTS} aria-label={t('attach')} title={t('attach')}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 7h3l2-3h6l2 3h3v12H4z" />
                <circle cx="12" cy="13" r="3.5" />
              </svg>
            </button>
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
            <button className="send-btn" onClick={submit} disabled={busy || (!text.trim() && attachments.length === 0) || (isNew && !cwd.trim())} aria-label={t('send')} title={t('send')}>
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
