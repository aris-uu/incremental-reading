import { useEffect, useState } from "react";
import { api, fmtDays, nextTopicInterval } from "../api";
import type { Notify } from "../notify";

/** Step for "more/less often": SuperMemo-style nudges of the topic's A-Factor. */
const STEP = 0.15;

/**
 * A topic's A-Factor (how fast its intervals grow): shown with the next
 * interval it gives, nudged with − (read more often) / + (less often), or
 * typed exactly by clicking the value.
 */
export function AFactor({ id, afactor, interval, notify, onChanged }: { id: number; afactor: number; interval: number; notify: Notify; onChanged?: () => void }) {
  const [af, setAf] = useState(afactor);
  useEffect(() => setAf(afactor), [id, afactor]);
  const set = async (v: number) => {
    const clamped = Math.round(Math.min(5, Math.max(1.05, v)) * 100) / 100;
    try {
      await api.setAfactor(id, clamped);
      setAf(clamped);
      notify(`A-Factor ${clamped.toFixed(2)}: next interval ${fmtDays(nextTopicInterval(interval, clamped))} after reading`, { undo: true });
      onChanged?.();
    } catch (e) {
      notify(String(e));
    }
  };
  const ask = () => {
    const v = window.prompt("A-Factor (1.05–5): each read multiplies the interval by this", af.toFixed(2));
    const n = v == null ? NaN : Number(v.replace(",", "."));
    if (!Number.isNaN(n)) void set(n);
  };
  return (
    <span className="afactor" title={`Each read multiplies the interval by the A-Factor. Next: ${fmtDays(nextTopicInterval(interval, af))}`}>
      <button className="small-btn" onClick={() => void set(af - STEP)} title="Read more often (lower A-Factor)">−</button>
      <a onClick={ask} className="mono">AF {af.toFixed(2)}</a>
      <button className="small-btn" onClick={() => void set(af + STEP)} title="Read less often (higher A-Factor)">+</button>
    </span>
  );
}
