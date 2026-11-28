// A small, safe Markdown renderer for the chat page (#151). The input is escaped with esc() FIRST, so no
// tag or attribute from the text can survive; only the markup built here is HTML. Supported: paragraphs,
// line breaks, fenced code blocks, inline code, **bold**, *italic* / _italic_, headings, bullet and
// numbered lists, block quotes, [links](https://…) and bare https URLs. Links open in a new tab with
// rel="noopener noreferrer". Anything else stays as plain (escaped) text.
import { esc } from "./html";

/** Placeholder delimiters that cannot appear in escaped text. */
const P0 = "\u0000";
const P1 = "\u0001";

/** Only web links; escaped text has no quotes, so the URL cannot break out of the attribute. */
const URL_RE = /https?:\/\/[^\s<>()\u0000\u0001]+[^\s<>()\u0000\u0001.,;:!?'"*_\]]/g;

function link(href: string, label: string): string {
  return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

/** Inline markup over one escaped line run. */
function inline(escaped: string): string {
  const slots: string[] = [];
  const keep = (html: string) => `${P0}${slots.push(html) - 1}${P1}`;
  let s = escaped;
  // `code` first: nothing inside it is formatted.
  s = s.replace(/`([^`\n]+)`/g, (_, c: string) => keep(`<code>${c}</code>`));
  // [label](https://url)
  s = s.replace(/\[([^\]\n]{1,500})\]\((https?:\/\/[^\s)]{1,2000})\)/g, (_, label: string, href: string) => keep(link(href, label)));
  // Bare URLs.
  s = s.replace(URL_RE, (u) => keep(link(u, u)));
  s = s.replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__(?=\S)([^_\n]*?\S)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?![*\w])/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?![_\w])/g, "$1<em>$2</em>");
  return s.replace(new RegExp(`${P0}(\\d+)${P1}`, "g"), (_, i: string) => slots[Number(i)]);
}

type Block = { kind: "code"; lang: string; text: string } | { kind: "text"; lines: string[] };

/** Split raw text into fenced code blocks and text runs. An unclosed fence runs to the end. */
function blocks(text: string): Block[] {
  const out: Block[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let cur: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const fence = /^\s*(```|~~~)\s*([\w+.#-]{0,30})\s*$/.exec(lines[i]);
    if (!fence) {
      cur.push(lines[i]);
      continue;
    }
    if (cur.length) out.push({ kind: "text", lines: cur });
    cur = [];
    const code: string[] = [];
    let j = i + 1;
    while (j < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[j])) code.push(lines[j++]);
    out.push({ kind: "code", lang: fence[2], text: code.join("\n") });
    i = j;
  }
  if (cur.length) out.push({ kind: "text", lines: cur });
  return out;
}

/** One text run (raw lines) as paragraphs, headings, lists and quotes. */
function textHtml(lines: string[]): string {
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;
  let quote: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map((l) => inline(esc(l))).join("<br>")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((it) => `<li>${inline(esc(it))}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${quote.map((l) => inline(esc(l))).join("<br>")}</blockquote>`);
    quote = [];
  };
  const flush = () => {
    flushPara();
    flushList();
    flushQuote();
  };
  for (const line of lines) {
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      const level = Math.min(6, h[1].length + 2);
      out.push(`<h${level}>${inline(esc(h[2]))}</h${level}>`);
      continue;
    }
    const ul = /^\s{0,3}[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      flushQuote();
      const tag = ul ? "ul" : "ol";
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push((ul ?? ol)![1]);
      continue;
    }
    const q = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (q) {
      flushPara();
      flushList();
      quote.push(q[1]);
      continue;
    }
    // A continuation line of the last list item.
    if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    flushList();
    flushQuote();
    para.push(line);
  }
  flush();
  return out.join("");
}

export function renderMarkdown(text: string): string {
  // The placeholder characters are removed from the input so text can never forge a slot reference.
  return blocks(String(text ?? "").replace(/[\u0000\u0001]/g, ""))
    .map((b) => (b.kind === "code" ? `<pre class="code"${b.lang ? ` data-lang="${esc(b.lang)}"` : ""}><code>${esc(b.text)}</code></pre>` : textHtml(b.lines)))
    .join("");
}
