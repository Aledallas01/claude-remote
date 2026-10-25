import { useEffect, useState } from 'react';
import type { PendingRequest, Question } from '../types';
import type { T } from '../i18n';
import { ToolInput } from './Messages';

export interface Answer {
  behavior?: 'allow' | 'deny';
  always?: boolean;
  message?: string;
  answers?: Record<string, string | string[]>;
  response?: string;
  release?: boolean;
}

function Countdown({ until }: { until: string }) {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    const tick = () => setLeft(Math.max(0, Math.round((new Date(until).getTime() - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [until]);
  return <span className="countdown">{left}s</span>;
}

export function PermissionCard({ req, t, onAnswer, sessionTitle }: { req: PendingRequest; t: T; onAnswer: (a: Answer) => void; sessionTitle?: string }) {
  const [reason, setReason] = useState('');
  const [showReason, setShowReason] = useState(false);
  const canAlways = req.suggestions && req.suggestions.length > 0;
  return (
    <div className="card request permission">
      <div className="card-head">
        <span className="badge warn">{t('pending')}</span>
        <span className="tool-name">{req.toolName}</span>
        {req.expiresAt && (
          <span className="muted small">
            {t('expires')} <Countdown until={req.expiresAt} />
          </span>
        )}
      </div>
      {sessionTitle && <div className="muted small ellipsis">{sessionTitle}</div>}
      <div className="muted small">{req.source === 'hook' ? t('fromHook') : t('fromSdk')} · {req.cwd}</div>
      <div className="card-body">
        <ToolInput name={req.toolName} input={req.input} />
      </div>
      {showReason && <textarea className="input" rows={2} placeholder={t('denyReason')} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />}
      <div className="card-actions">
        <button className="btn primary" onClick={() => onAnswer({ behavior: 'allow' })}>
          {t('allow')}
        </button>
        {canAlways && (
          <button className="btn" onClick={() => onAnswer({ behavior: 'allow', always: true })}>
            {t('allowAlways')}
          </button>
        )}
        {showReason ? (
          <button className="btn danger" onClick={() => onAnswer({ behavior: 'deny', message: reason })}>
            {t('deny')}
          </button>
        ) : (
          <button className="btn danger" onClick={() => setShowReason(true)}>
            {t('deny')}
          </button>
        )}
        {req.source === 'hook' && (
          <button className="btn ghost" title={t('releaseHelp')} onClick={() => onAnswer({ release: true })}>
            {t('release')}
          </button>
        )}
      </div>
    </div>
  );
}

export function QuestionCard({ req, t, onAnswer, sessionTitle }: { req: PendingRequest; t: T; onAnswer: (a: Answer) => void; sessionTitle?: string }) {
  const questions: Question[] = Array.isArray(req.input.questions) ? req.input.questions : [];
  const [sel, setSel] = useState<Record<number, Set<string>>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const [otherOn, setOtherOn] = useState<Record<number, boolean>>({});

  const toggle = (qi: number, label: string, multi: boolean) => {
    setSel((prev) => {
      const next = { ...prev };
      const set = new Set(multi ? prev[qi] || [] : []);
      if (set.has(label)) set.delete(label);
      else set.add(label);
      next[qi] = set;
      return next;
    });
    if (!multi) setOtherOn((p) => ({ ...p, [qi]: false }));
  };

  const complete = questions.every((_, qi) => (otherOn[qi] && other[qi]?.trim()) || (sel[qi] && sel[qi].size > 0));

  const submit = () => {
    const answers: Record<string, string | string[]> = {};
    questions.forEach((q, qi) => {
      if (otherOn[qi] && other[qi]?.trim()) answers[q.question] = other[qi].trim();
      else {
        const labels = [...(sel[qi] || [])];
        answers[q.question] = q.multiSelect ? labels : labels[0] || '';
      }
    });
    onAnswer({ answers });
  };

  return (
    <div className="card request question">
      <div className="card-head">
        <span className="badge info">{t('needsInput')}</span>
        {req.expiresAt && (
          <span className="muted small">
            {t('expires')} <Countdown until={req.expiresAt} />
          </span>
        )}
      </div>
      {sessionTitle && <div className="muted small ellipsis">{sessionTitle}</div>}
      <div className="muted small">{req.source === 'hook' ? t('fromHook') : t('fromSdk')} · {req.cwd}</div>
      {questions.map((q, qi) => (
        <div className="q" key={qi}>
          {q.header && <div className="q-header">{q.header}</div>}
          <div className="q-text">{q.question}</div>
          <div className="options">
            {q.options.map((o) => {
              const on = sel[qi]?.has(o.label) && !otherOn[qi];
              return (
                <button key={o.label} className={`option ${on ? 'on' : ''}`} onClick={() => toggle(qi, o.label, !!q.multiSelect)}>
                  <div className="option-label">{o.label}</div>
                  {o.description && <div className="option-desc">{o.description}</div>}
                </button>
              );
            })}
            <button
              className={`option ${otherOn[qi] ? 'on' : ''}`}
              onClick={() => {
                setOtherOn((p) => ({ ...p, [qi]: !p[qi] }));
                if (!q.multiSelect) setSel((p) => ({ ...p, [qi]: new Set() }));
              }}
            >
              <div className="option-label">{t('other')}</div>
            </button>
          </div>
          {otherOn[qi] && <textarea className="input" rows={2} placeholder={t('otherPlaceholder')} value={other[qi] || ''} onChange={(e) => setOther((p) => ({ ...p, [qi]: e.target.value }))} autoFocus />}
        </div>
      ))}
      <div className="card-actions">
        <button className="btn primary" disabled={!complete} onClick={submit}>
          {t('submit')}
        </button>
        {req.source === 'hook' && (
          <button className="btn ghost" title={t('releaseHelp')} onClick={() => onAnswer({ release: true })}>
            {t('release')}
          </button>
        )}
      </div>
    </div>
  );
}

export function RequestCard(props: { req: PendingRequest; t: T; onAnswer: (a: Answer) => void; sessionTitle?: string; highlight?: boolean }) {
  const { highlight, ...rest } = props;
  return (
    <div id={`req-${props.req.id}`} className={highlight ? 'highlight-wrap' : undefined}>
      {props.req.kind === 'question' ? <QuestionCard {...rest} /> : <PermissionCard {...rest} />}
    </div>
  );
}
