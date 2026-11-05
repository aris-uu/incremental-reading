import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import { renderField, sentenceAround, sentenceHtml, yomitanEntries, yomitanFields, type Fields } from "./japanese";
import { loadPrefs } from "./prefs";
import type { Notify } from "./notify";

/** Characters sent to Yomitan from the cursor on (it finds the longest word). */
const SCAN = 20;
const BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, blockquote, td, .hook-line";

interface Hit {
  block: HTMLElement;
  /** Offset of the cursor in the block's text. */
  offset: number;
  text: string;
  x: number;
  y: number;
}

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const d = document as any;
  if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  const r: Range | null = d.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

function textNodes(block: HTMLElement): Text[] {
  const out: Text[] = [];
  const w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    // Skip ruby readings and widgets.
    if ((n.parentElement?.closest("rt, rp, [contenteditable=false]") ?? null) === null) out.push(n as Text);
  }
  return out;
}

/** Text node + offset → offset in the block's text, and back. */
function blockOffset(block: HTMLElement, node: Node, offset: number): number | null {
  let at = 0;
  for (const t of textNodes(block)) {
    if (t === node) return at + offset;
    at += t.data.length;
  }
  return null;
}

export function rangeIn(block: HTMLElement, start: number, end: number): Range | null {
  const r = document.createRange();
  let at = 0;
  let started = false;
  for (const t of textNodes(block)) {
    const len = t.data.length;
    if (!started && start <= at + len) {
      r.setStart(t, Math.max(0, start - at));
      started = true;
    }
    if (started && end <= at + len) {
      r.setEnd(t, Math.max(0, end - at));
      return r;
    }
    at += len;
  }
  return null;
}

/** What's under the mouse: the block, the cursor offset and its text. */
function hitAt(container: HTMLElement, x: number, y: number): Hit | null {
  const c = caretAt(x, y);
  if (!c || c.node.nodeType !== Node.TEXT_NODE || !container.contains(c.node)) return null;
  const t = c.node as Text;
  // The caret APIs return the nearest caret position (before or after the
  // character, depending on which half the mouse is over): find the character
  // actually under the mouse, or give up (the mouse is beside the text).
  const charBox = (i: number) => {
    const ch = document.createRange();
    ch.setStart(t, i);
    ch.setEnd(t, i + 1);
    return ch.getBoundingClientRect();
  };
  const inside = (b: DOMRect) => x >= b.left - 1 && x <= b.right + 1 && y >= b.top - 1 && y <= b.bottom + 1;
  const candidates = [c.offset, c.offset - 1].filter((i) => i >= 0 && i < t.data.length);
  const off = candidates.find((i) => inside(charBox(i)));
  if (off == null) return null;
  const box = charBox(off);
  const block = (t.parentElement?.closest(BLOCKS) as HTMLElement | null) ?? t.parentElement;
  if (!block || !container.contains(block)) return null;
  const offset = blockOffset(block, t, off);
  if (offset == null) return null;
  const text = textNodes(block).map((n) => n.data).join("");
  if (!text[offset] || /[\s\p{P}]/u.test(text[offset])) return null;
  return { block, offset, text, x: box.left, y: box.bottom };
}

interface Props {
  /** The element whose text can be looked up. */
  container: React.RefObject<HTMLElement | null>;
  /** Mined cards go under this topic (unless the deck preference says otherwise). */
  sourceId: number | null;
  sourceTitle: string;
  notify: Notify;
  /** Called after a card was made from the text at this range (e.g. to mark it). */
  onMined?: (itemId: number, range: Range) => void;
}

/**
 * Yomitan-style popup: hold Shift (or just rest the mouse, per the setting)
 * over Japanese text to see its entries from your Yomitan dictionaries, with
 * "+" to make a sentence card from the sentence under the cursor.
 */
export function LookupHover({ container, sourceId, sourceTitle, notify, onMined }: Props) {
  const [popup, setPopup] = useState<{ x: number; y: number; entries: Fields[] | null; error?: string; hit: Hit } | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const timer = useRef<number | undefined>(undefined);
  const last = useRef<string>("");
  const cache = useRef(new Map<string, Fields[]>());
  const popRef = useRef<HTMLDivElement>(null);

  const highlight = (r: Range | null) => {
    const h = (CSS as any).highlights;
    if (!h) return;
    if (r) h.set("ir-lookup", new (window as any).Highlight(r));
    else h.delete("ir-lookup");
  };

  const close = useCallback(() => {
    setPopup(null);
    last.current = "";
    highlight(null);
  }, []);

  const look = useCallback(async (hit: Hit) => {
    const scan = hit.text.slice(hit.offset, hit.offset + SCAN);
    const key = scan;
    if (key === last.current) return;
    last.current = key;
    setPopup((p) => ({ x: hit.x, y: hit.y, entries: p?.hit.block === hit.block && p.hit.offset === hit.offset ? p.entries : null, hit }));
    try {
      const entries = cache.current.get(key) ?? (await yomitanEntries(scan, 3, false));
      cache.current.set(key, entries);
      if (last.current !== key) return;
      const len = entries[0]?.match?.length || entries[0]?.word?.length || 1;
      highlight(entries.length ? rangeIn(hit.block, hit.offset, hit.offset + len) : null);
      setPopup({ x: hit.x, y: hit.y, entries, hit });
    } catch (e) {
      if (last.current === key) setPopup({ x: hit.x, y: hit.y, entries: [], error: String(e), hit });
    }
  }, []);

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const onMove = (ev: MouseEvent) => {
      const mode = loadPrefs().hover;
      if (mode === "off" || !loadPrefs().yomitanUrl) return;
      if (mode === "shift" && !ev.shiftKey) return;
      window.clearTimeout(timer.current);
      const { clientX: x, clientY: y } = ev;
      timer.current = window.setTimeout(() => {
        const hit = hitAt(el, x, y);
        if (hit) void look(hit);
      }, mode === "shift" ? 40 : 250);
    };
    el.addEventListener("mousemove", onMove);
    return () => el.removeEventListener("mousemove", onMove);
  }, [container, look]);

  // Close on Escape or a click outside the popup.
  useEffect(() => {
    if (!popup) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    const onDown = (e: MouseEvent) => !popRef.current?.contains(e.target as Node) && close();
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [close, popup]);

  const mine = async (entry: Fields) => {
    if (!popup) return;
    const { hit } = popup;
    const len = entry.match?.length || entry.word?.length || 1;
    try {
      // Fetch again with media, so the card has its audio.
      const full = (await yomitanFields(hit.text.slice(hit.offset, hit.offset + SCAN), true)) ?? entry;
      const chosen = full.word === entry.word ? full : { ...entry, wordAudio: "" };
      const s = sentenceAround(hit.text, hit.offset, hit.offset + len);
      const prefs = loadPrefs();
      const parent = prefs.mineInto === "deck" && prefs.mineDeck.trim() ? await api.ensureDeck(prefs.mineDeck) : sourceId;
      const { match: _m, ...fields } = chosen;
      const id = await api.createSentence(parent, { ...fields, sentence: sentenceHtml(s.sentence, s.start, s.end), miscInfo: sourceTitle }, ["mined"], null);
      setAdded((a) => new Set(a).add(`${hit.offset}:${entry.word}`));
      notify(`Sentence card: ${entry.word}`);
      const r = rangeIn(hit.block, hit.offset, hit.offset + len);
      if (r) onMined?.(id, r);
    } catch (e) {
      notify(String(e));
    }
  };

  if (!popup) return null;
  const top = Math.min(popup.y + 6, window.innerHeight - 320);
  const left = Math.max(8, Math.min(popup.x, window.innerWidth - 440));
  return createPortal(
    <div ref={popRef} className="hover-pop" style={{ top, left }}>
      {popup.entries == null && <p className="muted small">Looking up…</p>}
      {popup.error && <p className="muted small">{popup.error}</p>}
      {popup.entries?.length === 0 && !popup.error && <p className="muted small">No entries.</p>}
      {popup.entries?.map((e, i) => (
        <div key={i} className="hover-entry">
          <div className="hover-head">
            <span className="sc-word">{e.reading && e.reading !== e.word ? <ruby>{e.word}<rt>{e.reading}</rt></ruby> : e.word}</span>
            <span className="hover-meta" dangerouslySetInnerHTML={{ __html: renderField(`${e.pitchAccents ?? ""} ${e.frequencies ?? ""}`) }} />
            <span className="spacer" />
            {added.has(`${popup.hit.offset}:${e.word}`) ? (
              <span className="muted small">✓ added</span>
            ) : (
              <button className="small-btn" title="Sentence card from this sentence" onClick={() => void mine(e)}>＋</button>
            )}
          </div>
          <div className="sc-gloss" dangerouslySetInnerHTML={{ __html: renderField(e.definition || e.glossary || "") }} />
        </div>
      ))}
    </div>,
    document.body,
  );
}
