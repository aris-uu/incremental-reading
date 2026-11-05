import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { renderField, sentenceHtml, yomitanFields, type Fields } from "../japanese";
import { loadPrefs } from "../prefs";
import type { Notify } from "../notify";

interface Props {
  /** The sentence and the target word's offsets in it. */
  sentence: string;
  start: number;
  end: number;
  /** Topic it was mined from (the card goes under it, keeping the source). */
  sourceId: number | null;
  sourceTitle: string;
  onClose: () => void;
  onCreated: (id: number) => void;
  notify: Notify;
}

/**
 * Sentence mining from the reader: the target word is highlighted in its
 * sentence; Yomitan (through its API) fills in the reading, gloss, audio,
 * pitch accent and frequency. Enter adds the card.
 */
export function MineDialog({ sentence, start, end, sourceId, sourceTitle, onClose, onCreated, notify }: Props) {
  const [s, setS] = useState({ start, end });
  const [lookup, setLookup] = useState<Fields | null>(null);
  const [status, setStatus] = useState<string>("");
  const [word, setWord] = useState(sentence.slice(start, end));
  const [translation, setTranslation] = useState("");
  const [busy, setBusy] = useState(false);
  const prefs = loadPrefs();

  useEffect(() => {
    if (!prefs.yomitanUrl) return setStatus("Yomitan API is off (Tools → Japanese): the card gets the word only; add a gloss later.");
    let live = true;
    setStatus("Looking up in Yomitan…");
    yomitanFields(word)
      .then((f) => {
        if (!live) return;
        setLookup(f);
        setStatus(f ? "" : "Yomitan found nothing for this word.");
      })
      .catch((e) => live && setStatus(`Yomitan API not reachable: ${e}`));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [word]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        void add();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const add = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const fields: Fields = {
        ...(lookup ?? {}),
        word: lookup?.word || word,
        sentence: sentenceHtml(sentence, s.start, s.end),
        sentenceTranslation: translation,
        miscInfo: sourceTitle,
      };
      const parent = prefs.mineInto === "deck" && prefs.mineDeck.trim() ? await api.ensureDeck(prefs.mineDeck) : sourceId;
      const id = await api.createSentence(parent, fields, ["mined"], null);
      notify(`Sentence card: ${fields.word}`);
      onCreated(id);
    } catch (e) {
      notify(String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Grow or shrink the highlighted target by one character at either end. */
  const nudge = (side: "start" | "end", d: number) =>
    setS((x) => {
      const n = { ...x, [side]: Math.max(0, Math.min(sentence.length, x[side] + d)) };
      if (n.end <= n.start) return x;
      setWord(sentence.slice(n.start, n.end));
      return n;
    });

  const preview = useMemo(() => renderField(sentenceHtml(sentence, s.start, s.end)), [s, sentence]);
  const gloss = lookup ? renderField(lookup.definition || lookup.glossary || "") : "";

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal mine-modal">
        <div className="modal-tabs">
          <strong>Sentence card</strong>
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
        </div>
        <div className="modal-body">
          <div className="sc-sentence" dangerouslySetInnerHTML={{ __html: preview }} />
          <div className="row small">
            <span className="muted">target</span>
            <button className="small-btn" onClick={() => nudge("start", -1)} title="Extend left">◀+</button>
            <button className="small-btn" onClick={() => nudge("start", 1)} title="Shrink left">+▶</button>
            <input value={word} onChange={(e) => setWord(e.target.value)} title="Word to look up (dictionary form is found by Yomitan)" />
            <button className="small-btn" onClick={() => nudge("end", -1)} title="Shrink right">◀−</button>
            <button className="small-btn" onClick={() => nudge("end", 1)} title="Extend right">−▶</button>
          </div>
          {lookup && (
            <div className="mine-lookup">
              <div className="sc-word">
                {lookup.reading && lookup.reading !== lookup.word ? (
                  <ruby>
                    {lookup.word}
                    <rt>{lookup.reading}</rt>
                  </ruby>
                ) : (
                  lookup.word
                )}
              </div>
              <div className="sc-gloss" dangerouslySetInnerHTML={{ __html: gloss }} />
            </div>
          )}
          {status && <p className="muted small">{status}</p>}
          <label className="col small">
            <span className="muted">translation (optional)</span>
            <textarea rows={2} value={translation} onChange={(e) => setTranslation(e.target.value)} />
          </label>
          <div className="row-actions">
            <span className="muted small">
              Goes {prefs.mineInto === "deck" && prefs.mineDeck ? `into “${prefs.mineDeck}”` : `under “${sourceTitle}”`}
            </span>
            <span className="spacer" />
            <button className="primary" disabled={busy} onClick={() => void add()}>
              Add card <kbd>Enter</kbd>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
