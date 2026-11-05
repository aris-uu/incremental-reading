import { Extension, InputRule, Mark, generateJSON, mergeAttributes } from "@tiptap/react";
import { MathBlock, MathInline } from "./math";
import { Occlusion } from "./occlusion";
import { AudioNode } from "./audio";
import { toDisplaySrc, toStoredSrc } from "./assetSrc";

export { toDisplaySrc } from "./assetSrc";
import { looksLikeMarkdown, markdownToHtml } from "./markdown";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

// ---------- Local images ----------

/** Image node that stores local assets as `ir-asset:<file>` but displays them from the app. */
const LocalImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      src: {
        default: null,
        parseHTML: (el: HTMLElement) => toStoredSrc(el.getAttribute("src")),
        renderHTML: (attrs: { src: string | null }) => ({ src: toDisplaySrc(attrs.src) }),
      },
    };
  },
});

// ---------- Incremental-reading marks ----------

/** A span of text that was extracted into child element `id`. */
export const ExtractMark = Mark.create({
  name: "extract",
  inclusive: false,
  excludes: "",
  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => Number(el.getAttribute("data-extract")) || null,
        renderHTML: (a) => ({ "data-extract": a.id }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-extract]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes({ class: "ir-extract" }, HTMLAttributes), 0];
  },
});

/** A keyword that became cloze item `id`. */
export const ClozeMark = Mark.create({
  name: "cloze",
  inclusive: false,
  excludes: "",
  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => Number(el.getAttribute("data-cloze")) || null,
        renderHTML: (a) => ({ "data-cloze": a.id }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-cloze]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes({ class: "ir-cloze" }, HTMLAttributes), 0];
  },
});

/** Text the reader chose to skip. */
export const IgnoreMark = Mark.create({
  name: "ignore",
  inclusive: false,
  parseHTML() {
    return [{ tag: "span[data-ignore]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes({ class: "ir-ignore", "data-ignore": "" }, HTMLAttributes), 0];
  },
});

export const readPointKey = new PluginKey<number | null>("readPoint");

/** Read point: a bookmark position that follows edits to the document. */
export const ReadPoint = Extension.create({
  name: "readPoint",
  addProseMirrorPlugins() {
    return [
      new Plugin<number | null>({
        key: readPointKey,
        state: {
          init: () => null,
          apply(tr, value) {
            const meta = tr.getMeta(readPointKey);
            if (meta !== undefined) return meta as number | null;
            return value == null ? null : tr.mapping.map(value);
          },
        },
        props: {
          decorations(state) {
            const p = readPointKey.getState(state);
            if (p == null) return null;
            const pos = Math.max(0, Math.min(p, state.doc.content.size));
            const widget = Decoration.widget(
              pos,
              () => {
                const s = document.createElement("span");
                s.className = "ir-readpoint";
                s.title = "Read point";
                return s;
              },
              { side: -1, key: "readpoint" },
            );
            return DecorationSet.create(state.doc, [widget]);
          },
        },
      }),
    ];
  },
});

/**
 * Live Markdown: StarterKit already turns `# `, `- `, `1. `, `> `, ``` and
 * **bold** / *italic* / `code` / ~~strike~~ into formatting as you type.
 * This adds [text](url) links, and converts pasted Markdown (with math).
 */
const LiveMarkdown = Extension.create({
  name: "liveMarkdown",
  addInputRules() {
    const link = this.editor.schema.marks.link;
    return link
      ? [
          new InputRule({
            find: /\[([^\]]+)\]\((\S+)\)$/,
            handler: ({ state, range, match }) => {
              const [, text, href] = match;
              state.tr.replaceWith(range.from, range.to, state.schema.text(text, [link.create({ href })]));
            },
          }),
        ]
      : [];
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey("markdownPaste"),
        props: {
          handlePaste(_view, event) {
            const data = event.clipboardData;
            if (!data || data.getData("text/html")) return false; // rich paste: keep its formatting
            const text = data.getData("text/plain");
            if (!text || !looksLikeMarkdown(text)) return false;
            editor.commands.insertContent(markdownToHtml(text));
            return true;
          },
        },
      }),
    ];
  },
});

const base = [StarterKit.configure({ link: { openOnClick: false, autolink: true } }), LocalImage, MathInline, MathBlock, Occlusion, AudioNode, LiveMarkdown];

/** Topics: rich text plus extract/cloze/ignore marks and the read point. */
export const extensions = [...base, ExtractMark, ClozeMark, IgnoreMark, ReadPoint];
/** Item question/answer fields: plain rich text. */
export const fieldExtensions = base;

export const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };

export const textDoc = (text: string) => ({
  type: "doc",
  content: [text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" }],
});

export function parseDoc(json: string | undefined | null) {
  try {
    return json ? JSON.parse(json) : EMPTY_DOC;
  } catch {
    return EMPTY_DOC;
  }
}

/** HTML (from the clipboard, a fetched page or the extension) → topic document. */
export const htmlToDoc = (html: string) => generateJSON(html, extensions);

/** Remove IR marks from copied content so a child starts clean. */
export function stripIrMarks(nodes: any[]): any[] {
  return nodes.map((n) => {
    const out = { ...n };
    if (out.marks) {
      out.marks = out.marks.filter((m: any) => !["extract", "cloze", "ignore"].includes(m.type));
      if (out.marks.length === 0) delete out.marks;
    }
    if (out.content) out.content = stripIrMarks(out.content);
    return out;
  });
}
