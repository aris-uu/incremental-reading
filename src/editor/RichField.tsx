import { useEffect, useRef, useState } from "react";
import { FormatBar } from "./FormatBar";
import { EditorContent, useEditor } from "@tiptap/react";
import { fieldExtensions, parseDoc } from "./extensions";

interface Props {
  docJson: string;
  onChange: (docJson: string) => void;
  placeholder?: string;
  className?: string;
  autofocus?: boolean;
}

/** A small always-editable rich-text field (item question or answer). */
export function RichField({ docJson, onChange, placeholder, className, autofocus }: Props) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [focused, setFocused] = useState(false);
  const editor = useEditor({
    extensions: fieldExtensions,
    content: parseDoc(docJson),
    autofocus: autofocus ? "end" : false,
    editorProps: { attributes: { "data-placeholder": placeholder ?? "" } },
    onUpdate: ({ editor }) => onChangeRef.current(JSON.stringify(editor.getJSON())),
    onFocus: () => setFocused(true),
    onBlur: ({ event }) => {
      // Clicking the toolbar keeps focus (buttons don't take it), so this is a real blur.
      if (!(event?.relatedTarget instanceof HTMLElement && event.relatedTarget.closest(".format-bar"))) setFocused(false);
    },
  });
  // Show the placeholder while empty.
  useEffect(() => {
    if (!editor) return;
    const sync = () => editor.view.dom.classList.toggle("is-empty", editor.isEmpty);
    sync();
    editor.on("update", sync);
    return () => void editor.off("update", sync);
  }, [editor]);
  return (
    <div className={`field ${className ?? ""} ${focused ? "focused" : ""}`} onClick={() => editor?.commands.focus()}>
      {focused && <FormatBar editor={editor} compact />}
      <EditorContent editor={editor} />
    </div>
  );
}
