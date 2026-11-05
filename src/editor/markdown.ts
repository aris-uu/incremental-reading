const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const mathSpan = (tex: string) => `<span data-math-inline data-latex="${escapeHtml(tex)}"></span>`;
const mathDiv = (tex: string) => `<div data-math-block data-latex="${escapeHtml(tex.trim())}"></div>`;

/** Inline Markdown: code, math, bold, italic, strike, images, links. */
function inline(text: string): string {
  // Pull out code and math first so their contents aren't touched.
  const keep: string[] = [];
  const stash = (html: string) => `\u0000${keep.push(html) - 1}\u0000`;
  let t = text
    .replace(/`([^`]+)`/g, (_, c) => stash(`<code>${escapeHtml(c)}</code>`))
    .replace(/\\\((.+?)\\\)/g, (_, m) => stash(mathSpan(m)))
    .replace(/(^|[^\\$])\$([^\s$](?:[^$]*[^\s$\\])?)\$(?!\d)/g, (_, pre, m) => pre + stash(mathSpan(m)));
  t = escapeHtml(t)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/(^|\W)_([^_\s][^_]*)_(?=\W|$)/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>")
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[Number(i)]);
}

/**
 * Markdown → HTML for paste and file import: headings, lists, quotes, code
 * fences, rules, emphasis, links, images, and TeX math ($…$, $$…$$, \(…\), \[…\]).
 */
export function markdownToHtml(md: string): string {
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];
  let code: string[] | null = null;
  let math: string[] | null = null;
  let mathClose = "$$";
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (code) {
      if (line.trim().startsWith("```")) {
        out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = null;
      } else code.push(raw);
      continue;
    }
    if (math) {
      if (line.trim().endsWith(mathClose)) {
        math.push(line.trim().slice(0, -mathClose.length));
        out.push(mathDiv(math.join("\n")));
        math = null;
      } else math.push(raw);
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      flush();
      closeList();
      code = [];
      continue;
    }
    // Display math: $$…$$ or \[…\] on its own line(s).
    const open = trimmed.startsWith("$$") ? "$$" : trimmed.startsWith("\\[") ? "\\[" : null;
    if (open) {
      flush();
      closeList();
      mathClose = open === "$$" ? "$$" : "\\]";
      const rest = trimmed.slice(2);
      if (rest.trim().endsWith(mathClose) && rest.trim().length >= mathClose.length) out.push(mathDiv(rest.trim().slice(0, -mathClose.length)));
      else math = [rest];
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (h) {
      flush();
      closeList();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flush();
      closeList();
      out.push("<hr>");
    } else if (li) {
      flush();
      const kind = /\d/.test(li[1]) ? "ol" : "ul";
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li><p>${inline(li[2])}</p></li>`);
    } else if (trimmed.startsWith(">")) {
      flush();
      closeList();
      out.push(`<blockquote><p>${inline(trimmed.replace(/^>\s?/, ""))}</p></blockquote>`);
    } else if (!trimmed) {
      flush();
      closeList();
    } else {
      closeList();
      para.push(trimmed);
    }
  }
  flush();
  closeList();
  if (code) out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  if (math) out.push(mathDiv(math.join("\n")));
  return out.join("\n");
}

/** Heuristic: does pasted plain text use Markdown (or TeX) syntax? */
export function looksLikeMarkdown(text: string): boolean {
  return /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|\$\$)|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|`[^`]+`|(^|[^\\$])\$[^\s$](?:[^$]*[^\s$])?\$(?!\d)/.test(text);
}
