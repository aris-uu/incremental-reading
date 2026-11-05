import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { cardKind, playSound, renderField, soundsIn, type Fields } from "../japanese";
import { loadPrefs } from "../prefs";
import type { Notify } from "../notify";
import { MARKERS } from "../japanese";

/** Field HTML, made safe, with working play buttons. */
function Html({ html, className }: { html: string; className?: string }) {
  const safe = useMemo(() => renderField(html), [html]);
  if (!html?.trim()) return null;
  return (
    <div
      className={className}
      onClick={(e) => {
        const b = (e.target as HTMLElement).closest("[data-sound]") as HTMLElement | null;
        if (b?.dataset.sound) playSound(b.dataset.sound);
      }}
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  );
}

/** Word with its reading above it (when the reading differs). */
function Headword({ word, reading }: { word: string; reading: string }) {
  const w = word.replace(/<[^>]+>/g, "");
  const r = reading.replace(/<[^>]+>/g, "");
  return <div className="sc-word">{r && r !== w ? <ruby>{w}<rt>{r}</rt></ruby> : w}</div>;
}

const EDITABLE = ["word", "reading", "sentence", "sentenceTranslation", "definition", "glossary", "notes", "miscInfo", "picture", "wordAudio", "sentenceAudio", "pitchAccents", "frequencies", "freqSort", "sentenceCard", "audioCard"];

interface Props {
  id: number;
  fields: Fields;
  shown: boolean;
  editable: boolean;
  notify: Notify;
  onSaved?: (f: Fields) => void;
}

/**
 * A sentence card (Senren fields). Front: the sentence with the target word
 * highlighted (or the word alone, or audio only, per Senren's flags and the
 * default card type). Back: word and reading, pitch accent, the gloss, picture,
 * audio and the source.
 */
export function SentenceCard({ id, fields, shown, editable, notify, onSaved }: Props) {
  const [f, setF] = useState(fields);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Fields>(fields);
  useEffect(() => setF(fields), [id, fields]);
  const kind = cardKind(f);
  const autoplay = loadPrefs().autoplay;

  // Sentence audio on the front (audio cards), word audio on reveal.
  useEffect(() => {
    if (!autoplay) return;
    const src = shown ? soundsIn(f.wordAudio)[0] ?? soundsIn(f.sentenceAudio)[0] : kind === "audio" ? soundsIn(f.sentenceAudio)[0] ?? soundsIn(f.wordAudio)[0] : null;
    if (src) playSound(src);
  }, [autoplay, f.sentenceAudio, f.wordAudio, kind, shown]);

  // Senren's priority: selected text, then the preferred definition, then the full glossary.
  const pref = (f.dictionaryPreference ?? "").trim();
  const gloss = f.selectionText?.trim() ? f.selectionText : pref === "glossary" ? f.glossary || f.definition : f.definition || f.glossary;

  const save = async () => {
    try {
      await api.updateSentence(id, draft);
      setF(draft);
      setEditing(false);
      onSaved?.(draft);
      notify("Fields saved", { undo: true });
    } catch (e) {
      notify(String(e));
    }
  };

  if (editing)
    return (
      <div className="card sentence-card">
        <div className="sc-fields">
          {[...new Set([...EDITABLE, ...Object.keys(draft)])].map((k) => (
            <label key={k}>
              <span className="muted small">{k}</span>
              <textarea rows={k === "glossary" || k === "definition" ? 4 : 1} value={draft[k] ?? ""} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
            </label>
          ))}
        </div>
        <div className="row-actions">
          <span className="spacer" />
          <button onClick={() => setEditing(false)}>Cancel</button>
          <button className="primary" onClick={() => void save()}>Save fields</button>
        </div>
      </div>
    );

  return (
    <div className={`card sentence-card kind-${kind}`}>
      <div className="sc-front">
        {kind === "sentence" && <Html className="sc-sentence" html={f.sentence || f.word} />}
        {kind === "word" && <div className="sc-word big">{(f.word ?? "").replace(/<[^>]+>/g, "")}</div>}
        {kind === "audio" && (
          <button className="sc-play-big" onClick={() => playSound(soundsIn(f.sentenceAudio)[0] ?? soundsIn(f.wordAudio)[0] ?? "")}>▶ Listen</button>
        )}
      </div>
      {shown && (
        <div className="sc-back">
          <hr />
          {kind !== "sentence" && <Html className="sc-sentence small-sentence" html={f.sentence} />}
          <div className="sc-head">
            <Headword word={f.word ?? ""} reading={f.reading ?? ""} />
            {soundsIn(f.wordAudio).map((s) => (
              <button key={s} className="play" title="Word audio" onClick={() => playSound(s)}>▶</button>
            ))}
            {soundsIn(f.sentenceAudio).map((s) => (
              <button key={s} className="play" title="Sentence audio" onClick={() => playSound(s)}>▶ sentence</button>
            ))}
            <Html className="sc-pitch" html={f.pitchAccents} />
            <Html className="sc-freq" html={f.frequencies} />
          </div>
          <Html className="sc-translation" html={f.sentenceTranslation} />
          <Html className="sc-gloss" html={gloss} />
          <Html className="sc-picture" html={f.picture} />
          <Html className="sc-notes" html={f.notes} />
          <Html className="sc-source muted small" html={f.miscInfo} />
        </div>
      )}
      {editable && (
        <div className="row-actions">
          <span className="muted small">{Object.keys(MARKERS).length ? "Senren fields" : ""}</span>
          <span className="spacer" />
          <button className="small-btn" onClick={() => (setDraft(f), setEditing(true))}>Edit fields</button>
        </div>
      )}
    </div>
  );
}
