import { memo, useMemo } from 'react';
import type { Block, Msg } from '../types';
import type { T, Lang } from '../i18n';
import { renderMarkdown } from '../markdown';

type ToolUse = Block & { type: 'tool_use' };
type ToolResult = Block & { type: 'tool_result' };
type Results = Map<string, ToolResult>;

const PLAN_TOOL = /update_plan$/;
const RECAP_TOOL = /wrap_up$/;

function toolSummary(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return s(input.description) || s(input.command).split('\n')[0];
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return s(input.file_path) || s(input.notebook_path);
    case 'Glob':
    case 'Grep':
      return s(input.pattern);
    case 'WebFetch':
      return s(input.url);
    case 'WebSearch':
      return s(input.query);
    case 'Agent':
    case 'Task':
      return s(input.description);
    case 'AskUserQuestion': {
      const qs = input.questions as { question?: string }[] | undefined;
      return qs?.[0]?.question || '';
    }
    default: {
      const first = Object.values(input).find((v) => typeof v === 'string') as string | undefined;
      return first ? first.split('\n')[0].slice(0, 120) : '';
    }
  }
}

export function ToolInput({ name, input }: { name: string; input: Record<string, unknown> }) {
  if ((name === 'Bash' || name === 'PowerShell') && typeof input.command === 'string') {
    return (
      <>
        <pre className="code">{input.command}</pre>
        {typeof input.description === 'string' && <div className="muted small">{input.description}</div>}
      </>
    );
  }
  if (name === 'Edit' && typeof input.old_string === 'string') {
    return (
      <>
        <div className="small mono">{String(input.file_path || '')}</div>
        <pre className="code diff-old">{`- ${input.old_string}`}</pre>
        <pre className="code diff-new">{`+ ${String(input.new_string ?? '')}`}</pre>
      </>
    );
  }
  if (name === 'Write' && typeof input.content === 'string') {
    return (
      <>
        <div className="small mono">{String(input.file_path || '')}</div>
        <pre className="code">{input.content}</pre>
      </>
    );
  }
  return <pre className="code">{JSON.stringify(input, null, 2)}</pre>;
}

const Text = memo(function Text({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
});

// One action, expandable to its input and result.
function ToolRow({ block, results, t }: { block: ToolUse; results: Results; t: T }) {
  const res = results.get(block.id);
  const summary = toolSummary(block.name, block.input);
  return (
    <details className={`tool ${res ? (res.isError ? 'is-error' : 'ok') : 'pending'}`}>
      <summary>
        <span className="mark">⏺</span>
        <span className="tool-line">
          <span className="tool-name">{block.name}</span>
          {summary && <span className="tool-summary">{summary}</span>}
          <span className="tool-chev">▸</span>
        </span>
      </summary>
      <div className="tool-body">
        <ToolInput name={block.name} input={block.input} />
        {res && (
          <>
            <div className={`result-head ${res.isError ? 'err' : ''}`}>
              <span className="elbow">⎿</span>
              {res.isError ? t('error') : t('result')}
            </div>
            <pre className="code result">{res.text || '(empty)'}</pre>
          </>
        )}
      </div>
    </details>
  );
}

function ThinkingRow({ text, t }: { text: string; t: T }) {
  return (
    <details className="tool thinking">
      <summary>
        <span className="mark">∗</span>
        <span className="tool-line">
          <span className="tool-name">{t('thinking')}</span>
          <span className="tool-chev">▸</span>
        </span>
      </summary>
      <div className="tool-body">
        <pre className="code">{text}</pre>
      </div>
    </details>
  );
}

// ---------- natural-language summary of a run of actions ----------

const COMMANDS = new Set(['Bash', 'PowerShell']);
const FETCH = new Set(['WebFetch', 'WebSearch']);
const WRITE = new Set(['Write']);
const EDIT = new Set(['Edit', 'NotebookEdit']);
const READ = new Set(['Read']);

function pick(t: T, one: Parameters<T>[0], many: Parameters<T>[0], n: number) {
  return n === 1 ? t(one) : t(many).replace('{n}', String(n));
}

function describeRun(tools: ToolUse[], t: T): string {
  const count = (set: Set<string>) => tools.filter((b) => set.has(b.name)).length;
  const cmd = count(COMMANDS);
  const fetch = count(FETCH);
  const write = count(WRITE);
  const edit = count(EDIT);
  const read = count(READ);
  const other = tools.length - cmd - fetch - write - edit - read;
  const parts: string[] = [];
  if (cmd) parts.push(pick(t, 'runCmd1', 'runCmdN', cmd));
  if (fetch) parts.push(pick(t, 'runFetch1', 'runFetchN', fetch));
  if (write) parts.push(pick(t, 'runWrite1', 'runWriteN', write));
  if (edit) parts.push(pick(t, 'runEdit1', 'runEditN', edit));
  if (read) parts.push(pick(t, 'runRead1', 'runReadN', read));
  if (other) parts.push(parts.length ? pick(t, 'runOther1', 'runOtherN', other) : pick(t, 'usedTool1', 'usedToolN', other));
  const line = parts.join(', ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

// Lines added / removed by Edit and Write calls, for the "+12 -3" pills.
function diffStat(tools: ToolUse[]) {
  let add = 0;
  let del = 0;
  const lines = (s: unknown) => (typeof s === 'string' && s.length ? s.split('\n').length : 0);
  for (const b of tools) {
    if (b.name === 'Edit') {
      add += lines(b.input.new_string);
      del += lines(b.input.old_string);
    } else if (b.name === 'Write') {
      add += lines(b.input.content);
    }
  }
  return { add, del };
}

function ToolRun({ blocks, results, t }: { blocks: Block[]; results: Results; t: T }) {
  const tools = blocks.filter((b): b is ToolUse => b.type === 'tool_use');
  const errors = tools.filter((b) => results.get(b.id)?.isError).length;
  const pending = tools.filter((b) => !results.has(b.id)).length;
  const { add, del } = diffStat(tools);
  const label = tools.length ? describeRun(tools, t) : t('thinking');
  return (
    <details className={`run ${errors ? 'is-error' : pending ? 'pending' : ''}`}>
      <summary className="summary-line">
        <span className="summary-text">{label}</span>
        {(add > 0 || del > 0) && (
          <span className="diffstat">
            {add > 0 && <span className="pill add">+{add}</span>}
            {del > 0 && <span className="pill del">-{del}</span>}
          </span>
        )}
        {errors > 0 && (
          <span className="summary-err">
            {errors} {t('errorsShort')}
          </span>
        )}
        <span className="chev">›</span>
      </summary>
      <div className="run-body">
        {blocks.map((b, i) => (b.type === 'tool_use' ? <ToolRow key={i} block={b} results={results} t={t} /> : b.type === 'thinking' ? <ThinkingRow key={i} text={b.text} t={t} /> : null))}
      </div>
    </details>
  );
}

// ---------- plan (task list) and recap cards ----------

export interface PlanItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

// Replays the update_plan calls of a conversation and returns, per call id, the plan state
// after that call, so each card shows what the list looked like at that moment.
export function planSnapshots(messages: Msg[]): Map<string, PlanItem[]> {
  const out = new Map<string, PlanItem[]>();
  let items: PlanItem[] = [];
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.type !== 'tool_use' || !PLAN_TOOL.test(b.name)) continue;
      const input = b.input as { items?: { content?: string; status?: string }[]; advance?: boolean; done?: number[]; start?: number };
      if (Array.isArray(input.items)) {
        items = input.items.map((x) => ({ content: String(x.content || ''), status: (x.status as PlanItem['status']) || 'pending' }));
      } else {
        items = items.map((x) => ({ ...x }));
        if (input.advance) {
          const cur = items.findIndex((x) => x.status === 'in_progress');
          if (cur >= 0) items[cur].status = 'completed';
          const next = items.findIndex((x, i) => x.status === 'pending' && i > cur);
          if (next >= 0) items[next].status = 'in_progress';
        }
        for (const d of input.done || []) if (items[d - 1]) items[d - 1].status = 'completed';
        if (input.start && items[input.start - 1]) {
          for (const x of items) if (x.status === 'in_progress') x.status = 'pending';
          items[input.start - 1].status = 'in_progress';
        }
      }
      out.set(b.id, items.map((x) => ({ ...x })));
    }
  }
  return out;
}

function PlanCard({ items }: { items: PlanItem[] }) {
  return (
    <div className="plan-card">
      {items.map((it, i) => (
        <div key={i} className={`plan-item ${it.status}`}>
          <span className="plan-icon" aria-hidden="true">
            {it.status === 'completed' ? (
              <svg viewBox="0 0 16 16" width="16" height="16">
                <circle cx="8" cy="8" r="7" fill="currentColor" />
                <path d="M4.8 8.3l2.1 2.1 4.3-4.6" fill="none" stroke="var(--bg)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : it.status === 'in_progress' ? (
              <svg viewBox="0 0 16 16" width="16" height="16">
                <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
                <circle cx="8" cy="8" r="3" fill="var(--accent)" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" width="16" height="16">
                <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
              </svg>
            )}
          </span>
          <span className="plan-text">{it.content}</span>
        </div>
      ))}
    </div>
  );
}

// The end-of-turn box (recap, question, reply buttons). Like in the app it belongs to the
// latest turn only: it is shown under the last message, not where the call happened.
export interface Recap {
  recap: string;
  ask: string;
  actions: { label: string; message: string }[];
}

export function lastRecap(messages: Msg[]): Recap | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && m.blocks.some((b) => b.type === 'text' && b.text.trim())) return null; // a newer turn started
    if (m.role !== 'assistant') continue;
    for (let j = m.blocks.length - 1; j >= 0; j--) {
      const b = m.blocks[j];
      if (b.type !== 'tool_use' || !RECAP_TOOL.test(b.name)) continue;
      const input = b.input as { recap?: string; ask?: string; actions?: { label?: string; message?: string; action?: string }[] };
      const actions = (Array.isArray(input.actions) ? input.actions : [])
        .filter((a) => a && typeof a.label === 'string' && a.label.trim() && !a.action) // app-only actions (commit, PR…) have no equivalent here
        .map((a) => ({ label: String(a.label), message: String(a.message || a.label) }));
      const recap = typeof input.recap === 'string' ? input.recap : '';
      const ask = typeof input.ask === 'string' ? input.ask : '';
      return recap || ask ? { recap, ask, actions } : null;
    }
  }
  return null;
}

export function RecapBox({ recap, t, onReply }: { recap: Recap; t: T; onReply: (text: string) => void }) {
  return (
    <div className="recap-card">
      <div className="recap-label">{t('recap')}</div>
      {recap.recap && <div>{recap.recap}</div>}
      {recap.ask && <div className="recap-ask">{recap.ask}</div>}
      {recap.actions.length > 0 && (
        <div className="recap-actions">
          {recap.actions.map((a, i) => (
            <button key={i} className={`btn ${i === 0 ? 'primary' : ''}`} onClick={() => onReply(a.message)}>
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- grouping ----------

export interface Group {
  role: 'user' | 'assistant';
  ts: string;
  items: Msg[];
}

function invisible(b: Block) {
  return b.type === 'tool_result' || (b.type === 'thinking' && !b.text.trim()) || (b.type === 'text' && !b.text.trim());
}

export function groupMessages(messages: Msg[]): Group[] {
  const groups: Group[] = [];
  for (const m of messages) {
    // Messages with nothing to show must not break the assistant's turn in two.
    if (m.blocks.every(invisible)) continue;
    const last = groups[groups.length - 1];
    if (last && last.role === m.role && m.role === 'assistant') last.items.push(m);
    else groups.push({ role: m.role, ts: m.ts, items: [m] });
  }
  return groups;
}

export function collectResults(messages: Msg[]) {
  const map: Results = new Map();
  for (const m of messages) for (const b of m.blocks) if (b.type === 'tool_result') map.set(b.toolUseId, b);
  return map;
}

export function relativeTime(ts: string, lang: Lang, now = Date.now()) {
  const d = new Date(ts).getTime();
  if (Number.isNaN(d)) return '';
  const diff = Math.round((d - now) / 1000);
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  if (abs < 45) return rtf.format(0, 'second').replace(/^./, (c) => c.toLowerCase());
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

// Assistant turns: text flows in the page; consecutive actions fold into one summary line;
// plan updates and recaps get their own cards.
type Run = { kind: 'text'; block: Block; key: string } | { kind: 'tools'; blocks: Block[]; key: string } | { kind: 'plan'; id: string; key: string };

function splitRuns(items: Msg[]): Run[] {
  const runs: Run[] = [];
  items.forEach((m, i) => {
    m.blocks.forEach((b, j) => {
      const key = `${m.uuid || i}:${j}`;
      if (invisible(b)) return;
      if (b.type === 'tool_use' && PLAN_TOOL.test(b.name)) {
        runs.push({ kind: 'plan', id: b.id, key });
        return;
      }
      if (b.type === 'tool_use' && RECAP_TOOL.test(b.name)) return; // shown once, under the last message (RecapBox)
      const isTool = b.type === 'tool_use' || b.type === 'thinking';
      if (!isTool) {
        runs.push({ kind: 'text', block: b, key });
        return;
      }
      const last = runs[runs.length - 1];
      if (last && last.kind === 'tools') last.blocks.push(b);
      else runs.push({ kind: 'tools', blocks: [b], key });
    });
  });
  return runs;
}

export const MessageGroup = memo(function MessageGroup({ group, results, plans, t, lang }: { group: Group; results: Results; plans: Map<string, PlanItem[]>; t: T; lang: Lang }) {
  if (group.role === 'user') {
    return (
      <div className="msg user">
        <div className="bubble">
          {group.items.map((m, i) => (
            <div key={m.uuid || i} className={m.optimistic ? 'optimistic' : ''}>
              {m.blocks.map((b, j) => (b.type === 'text' ? <Text key={j} text={b.text} /> : b.type === 'image' ? <div key={j} className="muted small">[image]</div> : null))}
            </div>
          ))}
        </div>
        <div className="msg-meta">{relativeTime(group.ts, lang)}</div>
      </div>
    );
  }
  const runs = splitRuns(group.items);
  return (
    <div className="msg assistant">
      {runs.map((r) => {
        switch (r.kind) {
          case 'text':
            return r.block.type === 'text' ? <Text key={r.key} text={r.block.text} /> : <div key={r.key} className="muted small">[image]</div>;
          case 'tools':
            return <ToolRun key={r.key} blocks={r.blocks} results={results} t={t} />;
          case 'plan': {
            const items = plans.get(r.id);
            return items && items.length ? <PlanCard key={r.key} items={items} /> : null;
          }
          default:
            return null;
        }
      })}
    </div>
  );
});
