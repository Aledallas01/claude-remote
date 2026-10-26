import { useState } from 'react';
import type { Connection } from '../types';
import type { T, Lang } from '../i18n';
import { normalizeAgentUrl, normalizeToken, parseLink } from '../agent';
import { QrScanner } from './QrScanner';

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
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const parsed = parseLink(link);
  const canScan = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

  // A scanned QR holds the same link the agent prints: connect right away.
  const onScanned = (text: string) => {
    const c = parseLink(text);
    setScanning(false);
    if (c) {
      setScanError(null);
      onConnect(c, remember);
    } else {
      setScanError(t('qrNotRecognized'));
      setLink(text);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const c = parsed || (url && token ? { url: normalizeAgentUrl(normalizeToken(url)), token: normalizeToken(token) } : null);
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
        {canScan && !scanning && (
          <button className="btn primary scan-btn" type="button" onClick={() => setScanning(true)}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10" />
            </svg>
            {t('scanQr')}
          </button>
        )}
        {scanning && <QrScanner t={t} onResult={onScanned} onClose={() => setScanning(false)} />}
        {scanError && <div className="alert error">{scanError}</div>}
        <label className="field">
          <span>{t('pasteLink')}</span>
          <input className="input" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…/#a=wss://…&t=…" autoComplete="off" spellCheck={false} />
          {parsed && (
            <span className="muted small">
              ✓ {parsed.url} · token: {parsed.token.length} {t('chars')}
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

// A terracotta starburst, in the spirit of the Claude mark.
export function Logo({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" fill="var(--accent)">
      {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
        <rect key={deg} x="21.5" y="3" width="5" height="16" rx="2.5" transform={`rotate(${deg} 24 24)`} />
      ))}
      <circle cx="24" cy="24" r="6" />
    </svg>
  );
}
