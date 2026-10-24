// Tiny, safe markdown renderer: everything is HTML-escaped first, then a
// handful of constructs are turned into markup. No raw HTML passes through.
function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function inline(s: string) {
  let out = esc(s);
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  out = out.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer nofollow">$1</a>');
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer nofollow">$2</a>');
  return out;
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let i = 0;
  let listType: 'ul' | 'ol' | null = null;
  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```(\w+)?\s*$/);
    if (fence) {
      closeList();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++;
      html.push(`<pre><code${fence[1] ? ` class="lang-${esc(fence[1])}"` : ''}>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const lvl = Math.min(6, h[1].length + 2);
      html.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const type = ul ? 'ul' : 'ol';
      if (listType !== type) {
        closeList();
        listType = type;
        html.push(`<${type}>`);
      }
      html.push(`<li>${inline((ul || ol)![1])}</li>`);
      i++;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      closeList();
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      html.push(`<blockquote>${inline(buf.join('\n')).replace(/\n/g, '<br>')}</blockquote>`);
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      closeList();
      html.push('<hr>');
      i++;
      continue;
    }
    if (!line.trim()) {
      closeList();
      i++;
      continue;
    }
    closeList();
    const buf: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,6}\s|[-*•]\s|\d+[.)]\s|>)/.test(lines[i])) buf.push(lines[i++]);
    html.push(`<p>${inline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  closeList();
  return html.join('');
}
