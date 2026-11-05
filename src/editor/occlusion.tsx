import { Node, mergeAttributes } from "@tiptap/react";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { toDisplaySrc } from "./assetSrc";

/** [x, y, w, h] as fractions of the image size. */
export type Rect = [number, number, number, number];

export interface OcclusionAttrs {
  src: string;
  rects: Rect[];
  /** The region this item asks about. */
  active: number;
  /** Answer side: the active region is uncovered. */
  reveal: boolean;
}

const pct = (v: number) => `${(v * 100).toFixed(3)}%`;

function maskClass(i: number, a: OcclusionAttrs) {
  return i === a.active ? (a.reveal ? "mask active revealed" : "mask active") : "mask";
}

function OcclusionView({ node }: NodeViewProps) {
  const a = node.attrs as OcclusionAttrs;
  return (
    <NodeViewWrapper className="ir-occl" contentEditable={false} data-drag-handle="">
      <img src={toDisplaySrc(a.src) ?? ""} alt="" draggable={false} />
      {(a.rects ?? []).map((r, i) => (
        <div key={i} className={maskClass(i, a)} style={{ left: pct(r[0]), top: pct(r[1]), width: pct(r[2]), height: pct(r[3]) }}>
          {i === a.active && !a.reveal ? "?" : ""}
        </div>
      ))}
    </NodeViewWrapper>
  );
}

/**
 * Image occlusion: an image with regions covered. Each item hides all regions
 * and asks about one (highlighted); its answer side uncovers that one.
 */
export const Occlusion = Node.create({
  name: "occlusion",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      src: { default: "" },
      rects: { default: [] },
      active: { default: 0 },
      reveal: { default: false },
    };
  },
  parseHTML() {
    return [
      {
        tag: "div[data-occlusion]",
        getAttrs: (el: HTMLElement) => {
          try {
            return JSON.parse(el.dataset.occlusion ?? "");
          } catch {
            return false;
          }
        },
      },
    ];
  },
  /** Static HTML (also what the Anki export uses): the image plus positioned masks. */
  renderHTML({ node, HTMLAttributes }) {
    const a = node.attrs as OcclusionAttrs;
    return [
      "div",
      mergeAttributes(HTMLAttributes, { class: "ir-occl", "data-occlusion": JSON.stringify(a) }),
      ["img", { src: toDisplaySrc(a.src) ?? "" }],
      ...(a.rects ?? []).map((r, i) => [
        "div",
        { class: maskClass(i, a), style: `left:${pct(r[0])};top:${pct(r[1])};width:${pct(r[2])};height:${pct(r[3])}` },
      ]),
    ];
  },
  renderText: () => "[image occlusion]",
  addNodeView() {
    return ReactNodeViewRenderer(OcclusionView);
  },
});

/** Question and answer documents for each region (hide all, guess one). */
export function occlusionItems(src: string, rects: Rect[], label = "") {
  return rects.map((_, i) => {
    const node = (reveal: boolean) => ({ type: "occlusion", attrs: { src, rects, active: i, reveal } });
    const extra = label ? [{ type: "paragraph", content: [{ type: "text", text: label }] }] : [];
    return {
      question: { type: "doc", content: [node(false)] },
      answer: { type: "doc", content: [node(true), ...extra] },
    };
  });
}
