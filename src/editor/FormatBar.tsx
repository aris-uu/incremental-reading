import { useEditorState, type Editor } from "@tiptap/react";

interface Props {
  editor: Editor | null;
  /** Smaller bar for item fields: no headings, rules or code blocks. */
  compact?: boolean;
}

/** Rich-text toolbar. Markdown typed directly still works; this is the mouse route. */
export function FormatBar({ editor, compact }: Props) {
  const s = useEditorState({
    editor,
    selector: ({ editor: ed }) =>
      ed
        ? {
            bold: ed.isActive("bold"),
            italic: ed.isActive("italic"),
            underline: ed.isActive("underline"),
            strike: ed.isActive("strike"),
            code: ed.isActive("code"),
            link: ed.isActive("link"),
            h1: ed.isActive("heading", { level: 1 }),
            h2: ed.isActive("heading", { level: 2 }),
            h3: ed.isActive("heading", { level: 3 }),
            bullet: ed.isActive("bulletList"),
            ordered: ed.isActive("orderedList"),
            quote: ed.isActive("blockquote"),
            codeBlock: ed.isActive("codeBlock"),
            canUndo: ed.can().undo(),
            canRedo: ed.can().redo(),
          }
        : null,
  });
  if (!editor || !s) return null;
  const c = () => editor.chain().focus();

  const link = () => {
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link URL (empty to remove)", prev ?? "https://");
    if (url == null) return;
    if (!url.trim()) c().extendMarkRange("link").unsetLink().run();
    else c().extendMarkRange("link").setLink({ href: url.trim() }).run();
  };
  const image = () => {
    const url = window.prompt("Image URL");
    if (url?.trim()) c().setImage({ src: url.trim() }).run();
  };
  /** Selected text becomes the TeX source. */
  const math = (block: boolean) => {
    const { from, to } = editor.state.selection;
    const latex = editor.state.doc.textBetween(from, to, " ");
    c()
      .insertContent({ type: block ? "mathBlock" : "mathInline", attrs: { latex } })
      .run();
  };

  const B = (label: string, title: string, on: boolean, run: () => void, cls = "") => (
    <button
      type="button"
      className={`fmt ${on ? "on" : ""} ${cls}`}
      title={title}
      // Keep the editor's selection when clicking.
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
    >
      {label}
    </button>
  );

  return (
    <div className={`format-bar ${compact ? "compact" : ""}`}>
      {B("B", "Bold (Ctrl+B, or **text**)", s.bold, () => c().toggleBold().run(), "b")}
      {B("I", "Italic (Ctrl+I, or *text*)", s.italic, () => c().toggleItalic().run(), "i")}
      {B("U", "Underline (Ctrl+U)", s.underline, () => c().toggleUnderline().run(), "u")}
      {B("S", "Strikethrough (~~text~~)", s.strike, () => c().toggleStrike().run(), "s")}
      {B("</>", "Inline code (`code`)", s.code, () => c().toggleCode().run())}
      <span className="fmt-sep" />
      {!compact && (
        <>
          {B("H1", "Heading 1 (# )", s.h1, () => c().toggleHeading({ level: 1 }).run())}
          {B("H2", "Heading 2 (## )", s.h2, () => c().toggleHeading({ level: 2 }).run())}
          {B("H3", "Heading 3 (### )", s.h3, () => c().toggleHeading({ level: 3 }).run())}
          {B("¶", "Normal paragraph", false, () => c().setParagraph().run())}
          <span className="fmt-sep" />
        </>
      )}
      {B("•", "Bullet list (- )", s.bullet, () => c().toggleBulletList().run())}
      {B("1.", "Numbered list (1. )", s.ordered, () => c().toggleOrderedList().run())}
      {B("❝", "Quote (> )", s.quote, () => c().toggleBlockquote().run())}
      {!compact && B("{ }", "Code block (```)", s.codeBlock, () => c().toggleCodeBlock().run())}
      {!compact && B("—", "Horizontal rule (---)", false, () => c().setHorizontalRule().run())}
      <span className="fmt-sep" />
      {B("🔗", "Link ([text](url))", s.link, link)}
      {B("🖼", "Image from URL", false, image)}
      {B("∑", "Inline math ($…$); selected text becomes the formula", false, () => math(false))}
      {!compact && B("∑∑", "Display math ($$ )", false, () => math(true))}
      {B("⌫", "Clear formatting", false, () => c().unsetAllMarks().clearNodes().run())}
      <span className="spacer" />
      {B("↶", "Undo typing (Ctrl+Z)", false, () => c().undo().run(), s.canUndo ? "" : "dim")}
      {B("↷", "Redo (Ctrl+Y)", false, () => c().redo().run(), s.canRedo ? "" : "dim")}
    </div>
  );
}
