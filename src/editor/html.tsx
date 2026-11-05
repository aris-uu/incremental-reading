import { useMemo, useState } from "react";
import { Node, mergeAttributes, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { sanitizeHtml } from "./sanitize";
import { playSound } from "./audio";

/**
 * Dictionary HTML kept as it is (Yomitan's glossary, pitch accent,
 * frequencies, the word with furigana): converting it to plain rich text
 * loses its structure. It sits in the document as one piece you can move or
 * delete; double-click to edit its HTML.
 */
function HtmlView({ node, updateAttributes, editor }: NodeViewProps) {
  const [editing, setEditing] = useState(false);
  const html = node.attrs.html as string;
  const kind = (node.attrs.kind as string) || "html";
  const safe = useMemo(() => sanitizeHtml(html), [html]);
  const inline = node.type.name === "htmlInline";
  return (
    <NodeViewWrapper as={inline ? "span" : "div"} className={`ir-html ${kind} ${inline ? "inline" : ""}`} data-drag-handle="">
      {editing ? (
        <textarea
          className="ir-html-edit"
          autoFocus
          defaultValue={html}
          rows={Math.min(14, 2 + html.length / 80)}
          onBlur={(e) => {
            updateAttributes({ html: e.target.value });
            setEditing(false);
          }}
          onKeyDown={(e) => e.key === "Escape" && (e.target as HTMLTextAreaElement).blur()}
        />
      ) : (
        <span
          className="ir-html-body"
          contentEditable={false}
          title={editor.isEditable ? "Double-click to edit the HTML" : undefined}
          onDoubleClick={() => editor.isEditable && setEditing(true)}
          onClick={(e) => {
            const b = (e.target as HTMLElement).closest("[data-sound]") as HTMLElement | null;
            if (b?.dataset.sound) playSound(b.dataset.sound);
          }}
          dangerouslySetInnerHTML={{ __html: safe }}
        />
      )}
    </NodeViewWrapper>
  );
}

const attrs = () => ({ html: { default: "" }, kind: { default: "html" } });

export const HtmlBlock = Node.create({
  name: "htmlBlock",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes: attrs,
  parseHTML() {
    return [{ tag: "div[data-html-block]", getAttrs: (el: HTMLElement) => ({ html: el.dataset.html ?? el.innerHTML, kind: el.dataset.htmlBlock || "html" }) }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-html-block": node.attrs.kind, "data-html": node.attrs.html })];
  },
  renderText: ({ node }) => (node.attrs.html as string).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  addNodeView() {
    return ReactNodeViewRenderer(HtmlView);
  },
});

export const HtmlInline = Node.create({
  name: "htmlInline",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: attrs,
  parseHTML() {
    return [{ tag: "span[data-html-inline]", getAttrs: (el: HTMLElement) => ({ html: el.dataset.html ?? el.innerHTML, kind: el.dataset.htmlInline || "html" }) }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-html-inline": node.attrs.kind, "data-html": node.attrs.html })];
  },
  renderText: ({ node }) => (node.attrs.html as string).replace(/<rt>.*?<\/rt>/g, "").replace(/<[^>]+>/g, "").trim(),
  addNodeView() {
    return ReactNodeViewRenderer(HtmlView);
  },
});
