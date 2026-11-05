import { Node, mergeAttributes, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { ASSET_BASE } from "./assetSrc";

let current: HTMLAudioElement | null = null;
/** Play a file from the collection's assets (one sound at a time). */
export function playSound(name: string) {
  current?.pause();
  current = new Audio(ASSET_BASE + name);
  void current.play().catch(() => {});
}

function AudioView({ node }: NodeViewProps) {
  const src = node.attrs.src as string;
  return (
    <NodeViewWrapper as="span" className="ir-sound" contentEditable={false} data-sound={src}>
      <button type="button" title={src} onMouseDown={(e) => e.preventDefault()} onClick={() => playSound(src)}>
        ▶
      </button>
    </NodeViewWrapper>
  );
}

/**
 * A sound (word or sentence audio from Yomitan, a clip…), stored in the
 * collection's assets and shown as a ▶ button inside the text. Anki's
 * `[sound:file]` becomes this node; the Anki export turns it back.
 */
export const AudioNode = Node.create({
  name: "audio",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { src: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "span[data-sound]", getAttrs: (el: HTMLElement) => ({ src: el.dataset.sound ?? "" }) }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-sound": node.attrs.src, class: "ir-sound" }), "▶"];
  },
  renderText: () => "",
  addNodeView() {
    return ReactNodeViewRenderer(AudioView);
  },
});
