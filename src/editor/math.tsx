import { useEffect, useRef, useState } from "react";
import { InputRule, Node, mergeAttributes, nodeInputRule } from "@tiptap/react";
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react";

// ---------- MathJax 4 (loaded once, offline, SVG output, New Computer Modern) ----------

/** Served from public/vendor (copied from node_modules by scripts/copy-mathjax.mjs). */
const VENDOR = "/vendor";
let ready: Promise<any> | null = null;

/** Load MathJax on first use, with every resource served locally. */
function mathjax(): Promise<any> {
  if (!ready) {
    ready = new Promise((resolve, reject) => {
      (window as any).MathJax = {
        loader: { paths: { mathjax: `${VENDOR}/mathjax`, fonts: `${VENDOR}/@mathjax` } },
        startup: { typeset: false },
        output: { font: "mathjax-newcm" },
        // "local": each SVG carries its own glyphs. A global cache lives in a hidden
        // element that's only added when MathJax typesets a whole page.
        svg: { fontCache: "local" },
        // No context menu, speech or enrichment: they'd load large extra components.
        // v4 takes these from the menu settings even with the menu off.
        options: {
          enableMenu: false,
          enableEnrichment: false,
          enableSpeech: false,
          enableBraille: false,
          enableExplorer: false,
          menuOptions: {
            settings: { enrich: false, speech: false, braille: false, collapsible: false, assistiveMml: false },
          },
        },
      };
      const s = document.createElement("script");
      s.src = `${VENDOR}/mathjax/tex-svg.js`;
      s.async = true;
      s.onload = () =>
        (window as any).MathJax.startup.promise.then(() => {
          const MJ = (window as any).MathJax;
          // Typesetting a page adds MathJax's CSS; rendering node by node, we add it ourselves.
          try {
            document.head.appendChild(MJ.svgStylesheet());
          } catch {
            /* older API: styles come with the first render */
          }
          resolve(MJ);
        }, reject);
      s.onerror = () => reject(new Error("MathJax failed to load"));
      document.head.appendChild(s);
    });
  }
  return ready;
}

/** Render TeX to an SVG element (errors are shown inline by MathJax). */
export async function renderTex(latex: string, display: boolean): Promise<Element> {
  const MJ = await mathjax();
  // tex2svgPromise waits for any font ranges or extensions loaded on demand.
  return MJ.tex2svgPromise ? MJ.tex2svgPromise(latex, { display }) : MJ.tex2svg(latex, { display });
}

/** Rendered TeX that re-renders when the source changes. */
export function Tex({ latex, display }: { latex: string; display: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let alive = true;
    if (!latex.trim()) {
      ref.current?.replaceChildren();
      return;
    }
    renderTex(latex, display)
      .then((el) => alive && ref.current?.replaceChildren(el))
      .catch(() => alive && ref.current && (ref.current.textContent = latex));
    return () => {
      alive = false;
    };
  }, [latex, display]);
  return <span ref={ref} className="tex" />;
}

// ---------- Editor nodes ----------

/** TeX source from pasted/imported HTML: our own spans, Wikipedia, MathML, old MathJax. */
function texFrom(el: HTMLElement): string | null {
  if (el.dataset.latex != null) return el.dataset.latex;
  const ann = el.querySelector('annotation[encoding="application/x-tex"]');
  if (ann?.textContent) return ann.textContent.trim().replace(/^\{\\displaystyle\s*(.*)\}$/s, "$1");
  if (el.tagName === "SCRIPT") return el.textContent?.trim() ?? null;
  const alt = el.querySelector("img.mwe-math-fallback-image-inline, img.mwe-math-fallback-image-display")?.getAttribute("alt");
  return alt ? alt.replace(/^\{\\displaystyle\s*(.*)\}$/s, "$1") : null;
}

function MathView({ node, updateAttributes, deleteNode, selected, editor, extension }: ReactNodeViewProps) {
  const block = extension.name === "mathBlock";
  const latex: string = node.attrs.latex ?? "";
  const display = block || !!node.attrs.display;
  const [editing, setEditing] = useState(!latex);
  const [draft, setDraft] = useState(latex);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setDraft(latex), [latex]);
  useEffect(() => {
    if (editing) requestAnimationFrame(() => area.current?.focus());
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (!draft.trim()) return deleteNode();
    if (draft !== latex) updateAttributes({ latex: draft });
    editor.commands.focus();
  };

  return (
    <NodeViewWrapper as={block ? "div" : "span"} className={`math-node ${block ? "block" : "inline"} ${selected ? "selected" : ""}`}>
      {editing && editor.isEditable ? (
        <span className="math-editor" contentEditable={false}>
          <textarea
            ref={area}
            value={draft}
            rows={block ? Math.max(2, draft.split("\n").length) : 1}
            placeholder={block ? "\\int_0^1 x^2\\,dx" : "e^{i\\pi}+1=0"}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape" || (e.key === "Enter" && (!block || e.ctrlKey))) {
                e.preventDefault();
                commit();
              }
            }}
            onBlur={commit}
          />
          <span className="math-preview">
            <Tex latex={draft} display={display} />
          </span>
        </span>
      ) : (
        <span
          className="math-render"
          contentEditable={false}
          title={`${latex}\n(double-click to edit)`}
          onDoubleClick={() => editor.isEditable && setEditing(true)}
        >
          <Tex latex={latex} display={display} />
        </span>
      )}
    </NodeViewWrapper>
  );
}

/** Inline math: $…$ */
export const MathInline = Node.create({
  name: "mathInline",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { latex: { default: "" }, display: { default: false } };
  },
  parseHTML() {
    const rule = (tag: string, display?: boolean) => ({
      tag,
      priority: 60,
      getAttrs: (el: HTMLElement) => {
        const latex = texFrom(el);
        return latex == null ? false : { latex, display: display ?? (el.getAttribute("display") === "block" || /block|display/.test(el.className)) };
      },
    });
    return [
      rule("span[data-math-inline]"),
      rule("span.mwe-math-element"),
      rule("math"),
      rule('script[type^="math/tex"]', false),
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-math-inline": "", "data-latex": node.attrs.latex }), `$${node.attrs.latex}$`];
  },
  renderText: ({ node }) => `$${node.attrs.latex}$`,
  addNodeView() {
    return ReactNodeViewRenderer(MathView);
  },
  addInputRules() {
    // $x^2$ → math. No space just inside the dollars, so "$5 and $6" stays text.
    return [
      new InputRule({
        find: /(?:^|[^\\$])(\$([^\s$](?:[^$]*[^\s$\\])?)\$)$/,
        handler: ({ state, range, match }) => {
          const whole = match[1];
          const start = range.to - whole.length;
          state.tr.replaceWith(start, range.to, this.type.create({ latex: match[2] }));
        },
      }),
    ];
  },
});

/** Display math on its own line: $$ then space starts one. */
export const MathBlock = Node.create({
  name: "mathBlock",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return { latex: { default: "" } };
  },
  parseHTML() {
    return [
      {
        tag: "div[data-math-block]",
        getAttrs: (el: HTMLElement) => ({ latex: el.dataset.latex ?? el.textContent ?? "" }),
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-math-block": "", "data-latex": node.attrs.latex }), `$$${node.attrs.latex}$$`];
  },
  renderText: ({ node }) => `$$${node.attrs.latex}$$`,
  addNodeView() {
    return ReactNodeViewRenderer(MathView);
  },
  addInputRules() {
    return [nodeInputRule({ find: /^\$\$\s$/, type: this.type })];
  },
});
