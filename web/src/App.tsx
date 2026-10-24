import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AgentClient, loadConnection, parseLink, saveConnection, type ConnStatus } from './agent';
import { detectLang, makeT, type Lang } from './i18n';
import type { AgentInfo, Connection, Msg, PendingRequest, Project, SessionMeta, SessionState } from './types';
import { Connect, Logo } from './components/Connect';
import { Sidebar } from './components/Sidebar';
import { Chat } from './components/Chat';
import { RequestCard, type Answer } from './components/Requests';

interface Conversation {
  messages: Msg[];
  loaded: boolean;
  loading: boolean;
  truncated: boolean;
  partial: string;
}

interface Draft {
  clientRef: string;
  cwd: string;
  messages: Msg[];
}

interface State {
  agent: AgentInfo | null;
  sessions: SessionMeta[];
  states: Record<string, SessionState>;
  pending: PendingRequest[];
  convs: Record<string, Conversation>;
  current: string | null; // session id, or 'new'
  draft: Draft | null;
  toasts: { id: number; text: string; kind?: 'info' | 'error' }[];
  tunnel?: string | null;
}

type Action =
  | { type: 'hello'; agent: AgentInfo; sessions: SessionMeta[]; states: SessionState[]; pending: PendingRequest[] }
  | { type: 'sessions'; sessions: SessionMeta[] }
  | { type: 'status'; sessionId: string; status: SessionState['status']; source: SessionState['source']; cwd?: string }
  | { type: 'request'; request: PendingRequest }
  | { type: 'request_resolved'; id: string }
  | { type: 'history'; sessionId: string; messages: Msg[]; truncated: boolean }
  | { type: 'loading'; sessionId: string }
  | { type: 'message'; sessionId: string; message: Msg }
  | { type: 'partial'; sessionId: string; text: string }
  | { type: 'partial_reset'; sessionId: string }
  | { type: 'select'; id: string | null }
  | { type: 'draft'; draft: Draft | null }
  | { type: 'draft_message'; message: Msg }
  | { type: 'session_init'; clientRef: string | null; sessionId: string; cwd: string }
  | { type: 'optimistic'; sessionId: string; message: Msg }
  | { type: 'toast'; text: string; kind?: 'info' | 'error' }
  | { type: 'untoast'; id: number }
  | { type: 'tunnel'; url: string | null }
  | { type: 'reset' };

const emptyConv = (): Conversation => ({ messages: [], loaded: false, loading: false, truncated: false, partial: '' });

let toastSeq = 1;

function sameUserText(a: Msg, b: Msg) {
  if (a.role !== 'user' || b.role !== 'user') return false;
  const ta = a.blocks.map((x) => (x.type === 'text' ? x.text : '')).join('\n').trim();
  const tb = b.blocks.map((x) => (x.type === 'text' ? x.text : '')).join('\n').trim();
  return !!ta && ta === tb;
}

function addMessage(conv: Conversation, message: Msg): Conversation {
  const msgs = conv.messages;
  if (message.uuid && msgs.some((m) => m.uuid === message.uuid)) return conv;
  // Replace an optimistic (locally echoed) user message with the real one.
  const idx = msgs.findIndex((m) => m.optimistic && sameUserText(m, message));
  if (idx >= 0) {
    const next = msgs.slice();
    next[idx] = message;
    return { ...conv, messages: next };
  }
  // The SDK echoes the user prompt and the transcript records it again: skip textual duplicates within 20s.
  if (message.role === 'user') {
    const recent = msgs.slice(-6).find((m) => sameUserText(m, message) && Math.abs(new Date(m.ts).getTime() - new Date(message.ts).getTime()) < 20000);
    if (recent) return conv;
  }
  const partial = message.role === 'assistant' && message.blocks.some((b) => b.type === 'text') ? '' : conv.partial;
  return { ...conv, messages: [...msgs, message], partial };
}

function reducer(state: State, a: Action): State {
  switch (a.type) {
    case 'hello': {
      const states: Record<string, SessionState> = {};
      for (const s of a.states) states[s.sessionId] = s;
      return { ...state, agent: a.agent, sessions: a.sessions, states, pending: a.pending };
    }
    case 'sessions':
      return { ...state, sessions: a.sessions };
    case 'status': {
      const states = { ...state.states };
      if (a.status === 'ended') delete states[a.sessionId];
      else states[a.sessionId] = { sessionId: a.sessionId, status: a.status, source: a.source, cwd: a.cwd || states[a.sessionId]?.cwd || '', updatedAt: new Date().toISOString() };
      return { ...state, states };
    }
    case 'request':
      if (state.pending.some((p) => p.id === a.request.id)) return state;
      return { ...state, pending: [...state.pending, a.request] };
    case 'request_resolved':
      return { ...state, pending: state.pending.filter((p) => p.id !== a.id) };
    case 'loading':
      return { ...state, convs: { ...state.convs, [a.sessionId]: { ...(state.convs[a.sessionId] || emptyConv()), loading: true } } };
    case 'history': {
      const prev = state.convs[a.sessionId] || emptyConv();
      // Keep live messages that arrived while loading and are not in the history.
      const ids = new Set(a.messages.map((m) => m.uuid));
      const extra = prev.messages.filter((m) => m.uuid && !ids.has(m.uuid) && !m.optimistic);
      return { ...state, convs: { ...state.convs, [a.sessionId]: { messages: [...a.messages, ...extra], loaded: true, loading: false, truncated: a.truncated, partial: prev.partial } } };
    }
    case 'message': {
      const prev = state.convs[a.sessionId] || emptyConv();
      return { ...state, convs: { ...state.convs, [a.sessionId]: addMessage(prev, a.message) } };
    }
    case 'optimistic': {
      const prev = state.convs[a.sessionId] || emptyConv();
      return { ...state, convs: { ...state.convs, [a.sessionId]: { ...prev, messages: [...prev.messages, a.message] } } };
    }
    case 'partial': {
      const prev = state.convs[a.sessionId] || emptyConv();
      return { ...state, convs: { ...state.convs, [a.sessionId]: { ...prev, partial: prev.partial + a.text } } };
    }
    case 'partial_reset': {
      const prev = state.convs[a.sessionId];
      if (!prev || !prev.partial) return state;
      return { ...state, convs: { ...state.convs, [a.sessionId]: { ...prev, partial: '' } } };
    }
    case 'select':
      return { ...state, current: a.id };
    case 'draft':
      return { ...state, draft: a.draft, current: a.draft ? 'new' : state.current };
    case 'draft_message':
      return state.draft ? { ...state, draft: { ...state.draft, messages: [...state.draft.messages, a.message] } } : state;
    case 'session_init': {
      if (!a.clientRef || !state.draft || state.draft.clientRef !== a.clientRef) return state;
      const conv: Conversation = { ...emptyConv(), messages: state.draft.messages, loaded: true };
      const meta: SessionMeta = { id: a.sessionId, cwd: a.cwd, title: state.draft.messages[0]?.blocks.map((b) => (b.type === 'text' ? b.text : '')).join(' ').slice(0, 80) || 'New session', firstPrompt: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), size: 0 };
      return {
        ...state,
        draft: null,
        current: state.current === 'new' ? a.sessionId : state.current,
        convs: { ...state.convs, [a.sessionId]: conv },
        sessions: state.sessions.some((s) => s.id === a.sessionId) ? state.sessions : [meta, ...state.sessions],
      };
    }
    case 'toast': {
      const id = toastSeq++;
      return { ...state, toasts: [...state.toasts.slice(-4), { id, text: a.text, kind: a.kind }] };
    }
    case 'untoast':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== a.id) };
    case 'tunnel':
      return { ...state, tunnel: a.url };
    case 'reset':
      return { ...initialState, current: state.current };
    default:
      return state;
  }
}

const initialState: State = { agent: null, sessions: [], states: {}, pending: [], convs: {}, current: null, draft: null, toasts: [] };

export default function App() {
  const [lang, setLangState] = useState<Lang>(detectLang);
  const t = useMemo(() => makeT(lang), [lang]);
  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem('claude-remote:lang', l);
    } catch {
      /* ignore */
    }
  };

  const clientRef = useRef<AgentClient>();
  if (!clientRef.current) clientRef.current = new AgentClient();
  const client = clientRef.current;

  const [conn, setConn] = useState<Connection | null>(() => {
    const fromLink = parseLink(window.location.hash);
    if (fromLink) {
      history.replaceState(null, '', window.location.pathname + window.location.search); // keep the token out of the URL/history
      saveConnection(fromLink);
      return fromLink;
    }
    return loadConnection();
  });
  const [status, setStatus] = useState<ConnStatus>('disconnected');
  const [statusDetail, setStatusDetail] = useState<string | undefined>();
  const [everConnected, setEverConnected] = useState(false);
  const [state, dispatch] = useReducer(reducer, initialState);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notify, setNotify] = useState<boolean>(() => typeof Notification !== 'undefined' && Notification.permission === 'granted');
  const stateRef = useRef(state);
  stateRef.current = state;

  // Wire the client once.
  useEffect(() => {
    const offStatus = client.onStatus((s, d) => {
      setStatus(s);
      setStatusDetail(d);
      if (s === 'connected') setEverConnected(true);
    });
    const offMsg = client.onMessage((m) => {
      switch (m.type) {
        case 'hello':
          dispatch({ type: 'hello', agent: m.agent, sessions: m.sessions, states: m.states, pending: m.pending });
          // Re-subscribe to the open conversation after a reconnect.
          {
            const cur = stateRef.current.current;
            if (cur && cur !== 'new') openSession(cur, true);
          }
          break;
        case 'sessions':
          dispatch({ type: 'sessions', sessions: m.sessions });
          break;
        case 'status':
          if (m.sessionId) dispatch({ type: 'status', sessionId: m.sessionId, status: m.status, source: m.source, cwd: m.cwd });
          break;
        case 'request':
          dispatch({ type: 'request', request: m.request });
          maybeNotify(m.request);
          break;
        case 'request_resolved':
          dispatch({ type: 'request_resolved', id: m.id });
          break;
        case 'message':
          if (m.sessionId) dispatch({ type: 'message', sessionId: m.sessionId, message: m.message });
          break;
        case 'partial':
          if (m.sessionId) dispatch({ type: 'partial', sessionId: m.sessionId, text: m.text });
          break;
        case 'partial_reset':
          if (m.sessionId) dispatch({ type: 'partial_reset', sessionId: m.sessionId });
          break;
        case 'session_init':
          dispatch({ type: 'session_init', clientRef: m.clientRef, sessionId: m.sessionId, cwd: m.cwd });
          if (m.clientRef) client.request({ type: 'open_session', sessionId: m.sessionId }).then((h) => dispatch({ type: 'history', sessionId: h.sessionId, messages: h.messages, truncated: h.truncated })).catch(() => {});
          break;
        case 'result':
          if (m.isError) dispatch({ type: 'toast', text: `${t('turnError')}: ${String(m.result || '').slice(0, 200)}`, kind: 'error' });
          break;
        case 'error':
          dispatch({ type: 'toast', text: String(m.message || 'error'), kind: 'error' });
          break;
        case 'notification':
          if (m.notificationType && m.notificationType !== 'permission_prompt') dispatch({ type: 'toast', text: m.message });
          break;
        case 'tunnel':
          dispatch({ type: 'tunnel', url: m.url });
          break;
        default:
          break;
      }
    });
    return () => {
      offStatus();
      offMsg();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, t]);

  useEffect(() => {
    if (conn) client.connect(conn);
    return () => client.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn?.url, conn?.token]);

  const openSession = useCallback(
    (id: string, silent = false) => {
      if (!silent) dispatch({ type: 'loading', sessionId: id });
      client
        .request({ type: 'open_session', sessionId: id }, 60000)
        .then((h) => dispatch({ type: 'history', sessionId: h.sessionId, messages: h.messages, truncated: h.truncated }))
        .catch((err) => dispatch({ type: 'toast', text: err.message, kind: 'error' }));
    },
    [client],
  );

  const select = (id: string) => {
    dispatch({ type: 'select', id });
    setSidebarOpen(false);
    if (!state.convs[id]?.loaded) openSession(id);
  };

  const [projects, setProjects] = useState<Project[]>([]);
  const startNew = async () => {
    setSidebarOpen(false);
    try {
      const r = await client.request({ type: 'list_projects' });
      setProjects(r.projects || []);
    } catch {
      /* ignore */
    }
    dispatch({ type: 'draft', draft: { clientRef: crypto.randomUUID(), cwd: '', messages: [] } });
  };

  const sendMessage = async (text: string, permissionMode: string, cwd?: string) => {
    const msg: Msg = { role: 'user', ts: new Date().toISOString(), blocks: [{ type: 'text', text }], optimistic: true, uuid: `local-${Date.now()}` };
    if (state.current === 'new' && state.draft) {
      const draft = { ...state.draft, cwd: cwd || state.draft.cwd };
      dispatch({ type: 'draft', draft });
      dispatch({ type: 'draft_message', message: msg });
      await client.request({ type: 'send', cwd: draft.cwd, text, permissionMode, clientRef: draft.clientRef });
      return;
    }
    if (!state.current) return;
    dispatch({ type: 'optimistic', sessionId: state.current, message: msg });
    await client.request({ type: 'send', sessionId: state.current, text, permissionMode });
  };

  const interrupt = () => {
    if (state.current && state.current !== 'new') client.request({ type: 'interrupt', sessionId: state.current }).catch(() => {});
  };

  const answer = (req: PendingRequest, a: Answer) => {
    client.request({ type: 'respond', requestId: req.id, ...a }).catch((err) => dispatch({ type: 'toast', text: err.message, kind: 'error' }));
    dispatch({ type: 'request_resolved', id: req.id });
  };

  const maybeNotify = (req: PendingRequest) => {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (document.visibilityState === 'visible' && document.hasFocus()) return;
    try {
      const n = new Notification(req.kind === 'question' ? t('needsInput') : `${t('pending')}: ${req.toolName}`, { body: req.cwd, tag: req.id });
      n.onclick = () => {
        window.focus();
        if (req.sessionId) select(req.sessionId);
      };
    } catch {
      /* ignore */
    }
  };

  const enableNotifications = async () => {
    if (typeof Notification === 'undefined') return;
    const p = await Notification.requestPermission();
    setNotify(p === 'granted');
  };

  // Title badge.
  useEffect(() => {
    const n = state.pending.length;
    document.title = n ? `(${n}) Claude Remote` : 'Claude Remote';
  }, [state.pending.length]);

  // Toast auto-dismiss.
  useEffect(() => {
    if (!state.toasts.length) return;
    const id = state.toasts[0].id;
    const timer = setTimeout(() => dispatch({ type: 'untoast', id }), 6000);
    return () => clearTimeout(timer);
  }, [state.toasts]);

  const onConnect = (c: Connection, remember: boolean) => {
    saveConnection(remember ? c : null);
    dispatch({ type: 'reset' });
    setConn(c);
  };
  const onForget = () => {
    client.close();
    saveConnection(null);
    setConn(null);
    dispatch({ type: 'reset' });
    setEverConnected(false);
  };

  if (!conn || (!everConnected && status !== 'connecting')) {
    return <Connect t={t} lang={lang} setLang={setLang} initial={conn} status={status} error={status === 'unauthorized' ? t('unauthorized') : statusDetail && status === 'disconnected' && conn ? `${t('disconnected')} (${statusDetail})` : undefined} onConnect={onConnect} onForget={onForget} />;
  }

  const currentMeta = state.current && state.current !== 'new' ? state.sessions.find((s) => s.id === state.current) : undefined;
  const currentConv = state.current && state.current !== 'new' ? state.convs[state.current] : undefined;
  const currentState = state.current && state.current !== 'new' ? state.states[state.current] : undefined;
  const currentPending = state.pending.filter((p) => p.sessionId && p.sessionId === state.current);
  const otherPending = state.pending.filter((p) => !p.sessionId || p.sessionId !== state.current);
  const titleOf = (id: string | null) => (id ? state.sessions.find((s) => s.id === id)?.title : undefined);

  return (
    <div className={`app ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <header className="topbar">
        <button className="icon-btn" onClick={() => setSidebarOpen((v) => !v)} aria-label={t('menu')}>
          ☰
        </button>
        <Logo size={24} />
        <span className="title">{t('appName')}</span>
        <span className={`conn ${status}`} title={statusDetail}>
          {status === 'connected' ? state.agent?.name || 'PC' : status === 'connecting' ? t('reconnecting') : t('disconnected')}
        </span>
        <span className="spacer" />
        {state.pending.length > 0 && (
          <span className="badge warn" title={t('pending')}>
            {state.pending.length}
          </span>
        )}
        {!notify && typeof Notification !== 'undefined' && (
          <button className="btn ghost compact" onClick={enableNotifications} title={t('enableNotifications')}>
            🔔
          </button>
        )}
        <select className="input compact" value={lang} onChange={(e) => setLang(e.target.value as Lang)} aria-label={t('language')}>
          <option value="en">EN</option>
          <option value="it">IT</option>
        </select>
        <button className="btn ghost compact" onClick={onForget} title={t('forget')}>
          ⏏
        </button>
      </header>

      <Sidebar t={t} sessions={state.sessions} states={state.states} pending={state.pending} current={state.current} onSelect={select} onNew={startNew} />
      <div className="backdrop" onClick={() => setSidebarOpen(false)} />

      <main className="main">
        {state.agent && state.agent.loggedIn === false && <div className="alert warn small">{t('notLoggedIn')}</div>}
        {state.agent && !state.agent.hooks.installed && <div className="alert info small">{t('hooksOff')}</div>}
        {otherPending.length > 0 && (
          <div className="pending-strip">
            {otherPending.map((p) => (
              <button key={p.id} className="pending-pill" onClick={() => p.sessionId && select(p.sessionId)}>
                {p.kind === 'question' ? '❓' : '🔐'} {p.toolName} · {titleOf(p.sessionId) || p.cwd}
              </button>
            ))}
          </div>
        )}
        {state.current === 'new' && state.draft ? (
          <Chat
            t={t}
            key="new"
            isNew
            draftCwd={state.draft.cwd}
            projects={projects}
            messages={state.draft.messages}
            partial=""
            loaded
            truncated={false}
            status={state.draft.messages.length ? 'running' : 'idle'}
            pending={[]}
            onSend={sendMessage}
            onInterrupt={() => {}}
            onAnswer={answer}
          />
        ) : state.current && currentMeta ? (
          <Chat
            t={t}
            key={state.current}
            meta={currentMeta}
            messages={currentConv?.messages || []}
            partial={currentConv?.partial || ''}
            loaded={!!currentConv?.loaded}
            truncated={!!currentConv?.truncated}
            status={currentState?.status || 'idle'}
            source={currentState?.source}
            pending={currentPending}
            onSend={sendMessage}
            onInterrupt={interrupt}
            onAnswer={answer}
          />
        ) : (
          <div className="empty">
            <Logo size={64} />
            <p className="muted">{t('pickSession')}</p>
            {state.pending.length > 0 && (
              <div className="cards">
                {state.pending.map((p) => (
                  <RequestCard key={p.id} req={p} t={t} onAnswer={(a) => answer(p, a)} sessionTitle={titleOf(p.sessionId)} />
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      <div className="toasts">
        {state.toasts.map((x) => (
          <div key={x.id} className={`toast ${x.kind || 'info'}`} onClick={() => dispatch({ type: 'untoast', id: x.id })}>
            {x.text}
          </div>
        ))}
      </div>
    </div>
  );
}
