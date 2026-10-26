// Small line diff (LCS) for Edit tool calls: old_string vs new_string are short snippets, so a
// quadratic DP is fine (capped). Produces rows for a unified-style view with context folding.
export type DiffLine = { kind: 'ctx' | 'add' | 'del'; text: string };
export type DiffRow = DiffLine | { kind: 'fold'; count: number; rows: DiffLine[] };

const MAX_LINES = 600;

export function lineDiff(oldText: string, newText: string): DiffRow[] {
  const a = oldText.replace(/\r\n?/g, '\n').split('\n');
  const b = newText.replace(/\r\n?/g, '\n').split('\n');
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [...a.map((text) => ({ kind: 'del' as const, text })), ...b.map((text) => ({ kind: 'add' as const, text }))];
  }
  // LCS table.
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'ctx', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ kind: 'del', text: a[i++] });
    } else {
      rows.push({ kind: 'add', text: b[j++] });
    }
  }
  while (i < n) rows.push({ kind: 'del', text: a[i++] });
  while (j < m) rows.push({ kind: 'add', text: b[j++] });
  return fold(rows, 2);
}

// Keeps `context` unchanged lines around each change; longer unchanged runs become a fold.
export function fold(rows: DiffLine[], context: number): DiffRow[] {
  const out: DiffRow[] = [];
  let run: DiffLine[] = [];
  const flush = (atEnd: boolean, atStart: boolean) => {
    if (!run.length) return;
    const keepHead = atStart ? 0 : context;
    const keepTail = atEnd ? 0 : context;
    if (run.length > keepHead + keepTail + 3) {
      out.push(...run.slice(0, keepHead));
      const hidden = run.slice(keepHead, run.length - keepTail);
      out.push({ kind: 'fold', count: hidden.length, rows: hidden });
      out.push(...run.slice(run.length - keepTail));
    } else {
      out.push(...run);
    }
    run = [];
  };
  let started = false;
  for (const r of rows) {
    if (r.kind === 'ctx') {
      run.push(r);
    } else {
      flush(false, !started);
      started = true;
      out.push(r);
    }
  }
  flush(true, !started);
  return out;
}

// A new file: every line is an addition; long files are folded after the first lines.
export function addedRows(text: string, visible = 40): DiffRow[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((t) => ({ kind: 'add' as const, text: t }));
  if (lines.length <= visible + 5) return lines;
  return [...lines.slice(0, visible), { kind: 'fold', count: lines.length - visible, rows: lines.slice(visible) }];
}
