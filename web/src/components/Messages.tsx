import { memo, useMemo } from 'react';
import type { Block, Msg } from '../types';
import type { T } from '../i18n';
import { renderMarkdown } from '../markdown';

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

function BlockView({ block, results, t }: { block: Block; results: Map<string, Block & { type: 'tool_result' }>; t: T }) {
  switch (block.type) {
    case 'text':
      return (
        <div className="turn">
          <span className="mark">⏺</span>
          <Text text={block.text} />
        </div>
      );
    case 'thinking':
      return block.text ? (
        <details className="tool thinking">
          <summary>
            <span className="mark">∗</span>
            <span className="tool-line">
              <span className="tool-name">{t('thinking')}</span>
              <span className="tool-chev">▸</span>
            </span>
          </summary>
          <div className="tool-body">
            <pre className="code">{block.text}</pre>
          </div>
        </details>
      ) : null;
    case 'tool_use': {
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
    case 'tool_result':
      return null; // rendered under its tool_use
    case 'image':
      return <div className="muted small">[image]</div>;
    default:
      return null;
  }
}

export interface Group {
  role: 'user' | 'assistant';
  ts: string;
  items: Msg[];
}

export function groupMessages(messages: Msg[]): Group[] {
  const groups: Group[] = [];
  for (const m of messages) {
    const onlyResults = m.blocks.every((b) => b.type === 'tool_result');
    if (onlyResults) continue; // attached to tool_use blocks
    const last = groups[groups.length - 1];
    if (last && last.role === m.role && m.role === 'assistant') last.items.push(m);
    else groups.push({ role: m.role, ts: m.ts, items: [m] });
  }
  return groups;
}

export function collectResults(messages: Msg[]) {
  const map = new Map<string, Block & { type: 'tool_result' }>();
  for (const m of messages) for (const b of m.blocks) if (b.type === 'tool_result') map.set(b.toolUseId, b);
  return map;
}

function fmtTime(ts: string) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Consecutive tool calls (and thinking) in an assistant turn collapse into one row,
// "Used N tools", like the Claude Code transcript. Text always stays visible.
type Run = { kind: 'text'; block: Block; key: string } | { kind: 'tools'; blocks: Block[]; key: string };

function splitRuns(items: Msg[]): Run[] {
  const runs: Run[] = [];
  items.forEach((m, i) => {
    m.blocks.forEach((b, j) => {
      const key = `${m.uuid || i}:${j}`;
      if (b.type === 'tool_result') return;
      const isTool = b.type === 'tool_use' || (b.type === 'thinking' && !!b.text);
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

function ToolRun({ blocks, results, t }: { blocks: Block[]; results: Map<string, Block & { type: 'tool_result' }>; t: T }) {
  const tools = blocks.filter((b): b is Block & { type: 'tool_use' } => b.type === 'tool_use');
  if (tools.length < 2) {
    return (
      <>
        {blocks.map((b, i) => (
          <BlockView key={i} block={b} results={results} t={t} />
        ))}
      </>
    );
  }
  const errors = tools.filter((b) => results.get(b.id)?.isError).length;
  const pending = tools.filter((b) => !results.has(b.id)).length;
  const names = [...new Set(tools.map((b) => b.name))];
  const shown = names.slice(0, 4).join(', ') + (names.length > 4 ? ', …' : '');
  const state = errors ? 'is-error' : pending ? 'pending' : 'ok';
  return (
    <details className={`tool run ${state}`}>
      <summary>
        <span className="mark">⏺</span>
        <span className="tool-line">
          <span className="tool-name">{t('usedTools').replace('{n}', String(tools.length))}</span>
          <span className="tool-summary">
            {shown}
            {errors > 0 && ` · ${errors} ${t('errorsShort')}`}
          </span>
          <span className="tool-chev">▸</span>
        </span>
      </summary>
      <div className="run-body">
        {blocks.map((b, i) => (
          <BlockView key={i} block={b} results={results} t={t} />
        ))}
      </div>
    </details>
  );
}

export const MessageGroup = memo(function MessageGroup({ group, results, t }: { group: Group; results: Map<string, Block & { type: 'tool_result' }>; t: T }) {
  const runs = group.role === 'assistant' ? splitRuns(group.items) : null;
  return (
    <div className={`msg ${group.role}`}>
      <div className="msg-meta">
        <span className="who">{group.role === 'user' ? t('you') : 'Claude'}</span>
        <span className="time">{fmtTime(group.ts)}</span>
      </div>
      <div className="bubble">
        {runs
          ? runs.map((r) => (r.kind === 'text' ? <BlockView key={r.key} block={r.block} results={results} t={t} /> : <ToolRun key={r.key} blocks={r.blocks} results={results} t={t} />))
          : group.items.map((m, i) => (
              <div key={m.uuid || i} className={m.optimistic ? 'optimistic' : ''}>
                {m.blocks.map((b, j) => (
                  <BlockView key={j} block={b} results={results} t={t} />
                ))}
              </div>
            ))}
      </div>
    </div>
  );
});
