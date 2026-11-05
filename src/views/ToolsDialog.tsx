import { useEffect, useState } from "react";
import type { Notify } from "../notify";
import { api, type PostponeReport, type PostponeSpec, type Settings } from "../api";
import { DEFAULT_APPEARANCE, FONTS, loadAppearance, saveAppearance, type Appearance } from "../appearance";

type Tab = "overload" | "settings" | "appearance" | "extension" | "backup";

interface Props {
  /** Element selected in the sidebar/reader, offered as the subset for postpone and mercy. */
  branch: { id: number; title: string } | null;
  onClose: () => void;
  onChanged: () => void;
  notify: Notify;
}

export function ToolsDialog({ branch, onClose, onChanged, notify }: Props) {
  const [tab, setTab] = useState<Tab>("overload");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-tabs">
          {(["overload", "settings", "appearance", "extension", "backup"] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {{ overload: "Postpone & Mercy", settings: "Scheduling", appearance: "Appearance", extension: "Browser extension", backup: "Backup" }[t]}
            </button>
          ))}
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>
        <div className="modal-body">
          {tab === "overload" && <Overload branch={branch} onChanged={onChanged} notify={notify} />}
          {tab === "settings" && <SettingsTab notify={notify} />}
          {tab === "appearance" && <AppearanceTab />}
          {tab === "extension" && <ExtensionTab />}
          {tab === "backup" && <BackupTab notify={notify} />}
        </div>
      </div>
    </div>
  );
}

function Overload({ branch, onChanged, notify }: Omit<Props, "onClose">) {
  const [useBranch, setUseBranch] = useState(false);
  const [spec, setSpec] = useState<Omit<PostponeSpec, "root">>({ topics: true, items: true, min_priority: 50, factor: 1.5 });
  const [sim, setSim] = useState<PostponeReport | null>(null);
  const [days, setDays] = useState(7);
  const [mercy, setMercy] = useState<number[] | null>(null);
  const root = useBranch && branch ? branch.id : null;

  useEffect(() => {
    api.postpone({ ...spec, root }, true).then(setSim);
  }, [spec, root]);
  useEffect(() => {
    api.mercy(root, days, true).then(setMercy);
  }, [days, root]);

  const runPostpone = async () => {
    const r = await api.postpone({ ...spec, root }, false);
    notify(`Postponed ${r.items} items and ${r.topics} topics`, { undo: true });
    onChanged();
    setSpec({ ...spec });
  };
  const runMercy = async () => {
    await api.mercy(root, days, false);
    notify(`Spread over ${days} days`, { undo: true });
    onChanged();
    setDays(days);
    api.mercy(root, days, true).then(setMercy);
  };

  return (
    <div className="tools">
      <label className="check">
        <input type="checkbox" disabled={!branch} checked={useBranch && !!branch} onChange={(e) => setUseBranch(e.target.checked)} />
        Only the branch of {branch ? `“${branch.title}”` : "(select an element first)"}
      </label>

      <h3>Postpone</h3>
      <p className="muted small">
        Pushes due elements into the future: delay = interval × (factor − 1), at least a day. Use it when the queue is too
        big; the least important material should give way.
      </p>
      <div className="form-grid">
        <label>
          <input type="checkbox" checked={spec.items} onChange={(e) => setSpec({ ...spec, items: e.target.checked })} /> items
        </label>
        <label>
          <input type="checkbox" checked={spec.topics} onChange={(e) => setSpec({ ...spec, topics: e.target.checked })} /> topics
        </label>
        <label>
          priority ≥
          <input type="number" min={0} max={100} value={spec.min_priority} onChange={(e) => setSpec({ ...spec, min_priority: Number(e.target.value) })} />%
        </label>
        <label>
          factor
          <input type="number" min={1.05} max={10} step={0.1} value={spec.factor} onChange={(e) => setSpec({ ...spec, factor: Number(e.target.value) })} />
        </label>
      </div>
      <div className="row-actions">
        <span className="muted small">{sim ? `Would postpone ${sim.items} items and ${sim.topics} topics` : "…"}</span>
        <button className="primary" disabled={!sim || sim.items + sim.topics === 0} onClick={runPostpone}>Postpone</button>
      </div>

      <h3>Mercy</h3>
      <p className="muted small">Spreads everything due evenly over the next days, most important first (today gets the first share).</p>
      <div className="form-grid">
        <label>
          over
          <input type="number" min={2} max={365} value={days} onChange={(e) => setDays(Math.max(2, Number(e.target.value)))} /> days
        </label>
      </div>
      {mercy && (
        <div className="mercy-bars">
          {mercy.map((n, i) => (
            <div key={i} className="mercy-bar" title={`day +${i}: ${n}`}>
              <div style={{ height: `${(n / Math.max(1, ...mercy)) * 100}%` }} />
              <span>{n}</span>
            </div>
          ))}
        </div>
      )}
      <div className="row-actions">
        <span className="muted small">{mercy ? `${mercy.reduce((a, b) => a + b, 0)} elements due` : "…"}</span>
        <button className="primary" disabled={!mercy || mercy.slice(1).every((n) => n === 0)} onClick={runMercy}>Apply mercy</button>
      </div>
    </div>
  );
}

function SettingsTab({ notify }: { notify: Notify }) {
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => {
    api.getSettings().then(setS);
  }, []);
  if (!s) return <p className="muted">Loading…</p>;
  const num = (k: keyof Settings, step = 1) => (
    <input type="number" step={step} value={s[k]} onChange={(e) => setS({ ...s, [k]: Number(e.target.value) })} />
  );
  return (
    <div className="tools">
      <h3>Daily budget (auto-postpone)</h3>
      <p className="muted small">
        At the start of each day, if more is due than this, the least important elements are postponed. Items are delayed
        only while their predicted recall stays above the floor.
      </p>
      <div className="form-grid">
        <label>items per day {num("item_budget")}</label>
        <label>topics per day {num("topic_budget")}</label>
        <label>never postpone priority below {num("protect_priority")}%</label>
        <label>recall floor {num("retention_floor", 0.01)}</label>
      </div>
      <h3>FSRS desired retention</h3>
      <p className="muted small">
        Important items are kept at higher recall (more frequent reviews). Retention moves linearly from the first value at
        priority 0% to the second at 100%.
      </p>
      <div className="form-grid">
        <label>at 0% {num("retention_top", 0.01)}</label>
        <label>at 100% {num("retention_bottom", 0.01)}</label>
      </div>
      <div className="row-actions">
        <span className="spacer" />
        <button className="primary" onClick={() => api.setSettings(s).then(() => notify("Settings saved"))}>Save</button>
      </div>
      <Optimizer notify={notify} />
    </div>
  );
}

function Optimizer({ notify }: { notify: Notify }) {
  const [info, setInfo] = useState<{ samples: number; optimized: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.fullStats().then((s) => setInfo({ samples: s.training_samples, optimized: s.optimized }));
  useEffect(() => {
    void load();
  }, []);
  const optimize = async () => {
    setBusy(true);
    try {
      const r = await api.optimize();
      notify(`FSRS fitted to ${r.samples} reviews`);
      void load();
    } catch (e) {
      notify(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h3>FSRS optimizer</h3>
      <p className="muted small">
        Fits the memory model to your own review history. Worth running once you have a few hundred reviews, then every month
        or so. {info && `${info.samples} training samples so far; using ${info.optimized ? "your fitted" : "default"} parameters.`}
      </p>
      <div className="row-actions">
        <span className="spacer" />
        {info?.optimized && (
          <button disabled={busy} onClick={() => api.resetParameters().then(() => (notify("Back to default parameters"), load()))}>
            Reset to defaults
          </button>
        )}
        <button className="primary" disabled={busy || !info || info.samples < 400} title={info && info.samples < 400 ? "Needs at least 400 samples" : ""} onClick={optimize}>
          {busy ? "Optimizing…" : "Optimize now"}
        </button>
      </div>
    </>
  );
}

/** Reading font, size, spacing and width. Applies live; saved per machine. */
function AppearanceTab() {
  const [a, setA] = useState<Appearance>(loadAppearance);
  const set = (patch: Partial<Appearance>) => {
    const next = { ...a, ...patch };
    setA(next);
    saveAppearance(next);
  };
  return (
    <div className="tools">
      <h3>Reading text</h3>
      <div className="form-grid">
        <label>
          font
          <select value={a.font} onChange={(e) => set({ font: e.target.value })}>
            {Object.entries(FONTS).map(([k, f]) => (
              <option key={k} value={k}>{f.label}</option>
            ))}
            <option value="custom">Custom…</option>
          </select>
        </label>
        {a.font === "custom" && (
          <label>
            family
            <input placeholder="e.g. Literata" value={a.customFont} onChange={(e) => set({ customFont: e.target.value })} />
          </label>
        )}
        <label>
          size
          <input type="range" min={13} max={26} value={a.size} onChange={(e) => set({ size: Number(e.target.value) })} />
          <span className="mono">{a.size}px</span>
        </label>
        <label>
          line spacing
          <input type="range" min={1.2} max={2.1} step={0.05} value={a.lineHeight} onChange={(e) => set({ lineHeight: Number(e.target.value) })} />
          <span className="mono">{a.lineHeight.toFixed(2)}</span>
        </label>
        <label>
          text width
          <input type="range" min={45} max={110} value={a.width} onChange={(e) => set({ width: Number(e.target.value) })} />
          <span className="mono">{a.width}ch</span>
        </label>
      </div>
      <h3>Interface</h3>
      <div className="form-grid">
        <label>
          font
          <select value={a.uiFont} onChange={(e) => set({ uiFont: e.target.value })}>
            <option value="system">System</option>
            <option value="humanist">Humanist sans</option>
            <option value="mono">Monospace</option>
          </select>
        </label>
      </div>
      <h3>Preview</h3>
      <div className="appearance-preview">
        <p>
          Incremental reading turns a pile of articles into lasting knowledge: read a little, <span className="ir-extract">extract what matters</span>, and turn
          key facts into <span className="ir-cloze">clozes</span> that spaced repetition keeps fresh.
        </p>
      </div>
      <div className="row-actions">
        <span className="spacer" />
        <button onClick={() => (setA(DEFAULT_APPEARANCE), saveAppearance(DEFAULT_APPEARANCE))}>Reset to defaults</button>
      </div>
    </div>
  );
}

function ExtensionTab() {
  const [info, setInfo] = useState<{ port: number; token: string } | null>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    api.extensionInfo().then(setInfo);
  }, []);
  return (
    <div className="tools">
      <h3>Import from the browser</h3>
      <ol className="small">
        <li>In Chrome or Edge, open <code>chrome://extensions</code>, turn on Developer mode, click “Load unpacked”, and pick the <code>browser-extension</code> folder of this project.</li>
        <li>Open the extension's options and paste the token below.</li>
        <li>On any page, click the extension: it sends the article (or your selection) to the Inbox.</li>
      </ol>
      {info && (
        <div className="form-grid">
          <label>port <code>{info.port}</code></label>
          <label>
            token <code className="token">{shown ? info.token : "•".repeat(12)}</code>
            <button className="small-btn" onClick={() => setShown(!shown)}>{shown ? "Hide" : "Show"}</button>
            <button className="small-btn" onClick={() => navigator.clipboard.writeText(info.token)}>Copy</button>
          </label>
        </div>
      )}
      <p className="muted small">The app only listens on 127.0.0.1 and rejects requests without this token.</p>
    </div>
  );
}

function BackupTab({ notify }: { notify: Notify }) {
  const [dir, setDir] = useState("");
  const [last, setLast] = useState<string | null>(null);
  useEffect(() => {
    api.dataDir().then(setDir);
  }, []);
  return (
    <div className="tools">
      <h3>Backup</h3>
      <p className="muted small">
        The whole collection is one SQLite file in <code>{dir}</code>. Images are in its <code>assets</code> folder.
        A backup writes a consistent copy to <code>backups</code>.
      </p>
      <div className="row-actions">
        <span className="muted small">{last}</span>
        <button
          className="primary"
          onClick={() =>
            api.backup().then((p) => {
              setLast(p);
              notify("Backup written");
            })
          }
        >
          Back up now
        </button>
      </div>
    </div>
  );
}
