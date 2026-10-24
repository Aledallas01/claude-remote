import { useState } from 'react';
import type { Connection } from '../types';
import type { T, Lang } from '../i18n';
import { normalizeAgentUrl, parseLink } from '../agent';

export function Connect({ t, lang, setLang, initial, status, error, onConnect, onForget }: {
  t: T;
  lang: Lang;
  setLang: (l: Lang) => void;
  initial: Connection | null;
  status: string;
  error?: string;
  onConnect: (c: Connection, remember: boolean) => void;
  onForget: () => void;
}) {
  const [link, setLink] = useState('');
  const [url, setUrl] = useState(initial?.url || '');
  const [token, setToken] = useState(initial?.token || '');
  const [remember, setRemember] = useState(true);
  const parsed = parseLink(link);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const c = parsed || (url && token ? { url: normalizeAgentUrl(url), token: token.trim() } : null);
    if (c) onConnect(c, remember);
  };

  return (
    <div className="connect-wrap">
      <form className="connect" onSubmit={submit}>
        <div className="brand">
          <Logo />
          <div>
            <h1>{t('appName')}</h1>
            <p className="muted">{t('tagline')}</p>
          </div>
        </div>
        <h2>{t('connectTitle')}</h2>
        <p className="muted small">{t('connectHelp')}</p>
        <pre className="code small">git clone https://github.com/Aledallas01/claude-remote{'\n'}cd claude-remote/agent{'\n'}start.bat   (Windows)   ·   npm install && npm start</pre>
        <label className="field">
          <span>{t('pasteLink')}</span>
          <input className="input" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…/#a=wss://…&t=…" autoComplete="off" spellCheck={false} />
          {parsed && (
            <span className="muted small">
              ✓ {parsed.url} · token {parsed.token.length} {parsed.token.length === 43 ? '✓' : '⚠'}
            </span>
          )}
        </label>
        <div className="divider">{t('orManual')}</div>
        <label className="field">
          <span>{t('agentAddress')}</span>
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="wss://xxxx.trycloudflare.com" autoComplete="off" spellCheck={false} disabled={!!parsed} />
        </label>
        <label className="field">
          <span>{t('token')}</span>
          <input className="input" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" disabled={!!parsed} />
        </label>
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span>
            {t('remember')}
            <br />
            <span className="muted small">{t('rememberHelp')}</span>
          </span>
        </label>
        {error && <div className="alert error">{error}</div>}
        <div className="row">
          <button className="btn primary" type="submit" disabled={status === 'connecting' || !(parsed || (url && token))}>
            {status === 'connecting' ? t('connecting') : t('connect')}
          </button>
          {initial && (
            <button className="btn ghost" type="button" onClick={onForget}>
              {t('forget')}
            </button>
          )}
          <span className="spacer" />
          <select className="input compact" value={lang} onChange={(e) => setLang(e.target.value as Lang)} aria-label={t('language')}>
            <option value="en">English</option>
            <option value="it">Italiano</option>
          </select>
        </div>
        <p className="muted small foot">
          Open source · <a href="https://github.com/Aledallas01/claude-remote" target="_blank" rel="noopener noreferrer">GitHub</a> · This page is a static client: your data goes only between this browser and your PC.
        </p>
      </form>
    </div>
  );
}

export function Logo({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <rect x="4" y="8" width="40" height="28" rx="6" fill="var(--accent)" />
      <rect x="10" y="14" width="28" height="16" rx="3" fill="var(--bg)" />
      <path d="M16 20h8M16 24h12" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="36" cy="36" r="8" fill="var(--ok)" stroke="var(--bg)" strokeWidth="3" />
    </svg>
  );
}
