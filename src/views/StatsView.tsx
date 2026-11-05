import { useEffect, useState } from "react";
import { api, type FullStats } from "../api";

/** Stacked daily bars, oldest/today on the left. */
function Bars({ series, labels, colors, height = 90 }: { series: number[][]; labels: string[]; colors: string[]; height?: number }) {
  const n = series[0]?.length ?? 0;
  const totals = Array.from({ length: n }, (_, i) => series.reduce((s, row) => s + row[i], 0));
  const max = Math.max(1, ...totals);
  return (
    <div className="bars" style={{ height }}>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="bar-col" title={`${labels[i]}: ${series.map((row) => row[i]).join(" / ")}`}>
          {series.map((row, k) => (
            <div key={k} style={{ height: `${(row[i] / max) * 100}%`, background: colors[k] }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function StatsView({ version }: { version: number }) {
  const [s, setS] = useState<FullStats | null>(null);
  useEffect(() => {
    api.fullStats().then(setS);
  }, [version]);
  if (!s) return <p className="muted pad">Loading…</p>;

  const histLabels = s.history.map((h) => (h.day === s.today ? "today" : `${s.today - h.day}d ago`));
  const foreLabels = s.forecast_items.map((_, i) => (i === 0 ? "today (incl. overdue)" : `in ${i}d`));
  const reviews30 = s.history.reduce((n, h) => n + h.again + h.pass, 0);
  const reads30 = s.history.reduce((n, h) => n + h.topics, 0);

  return (
    <div className="stats">
      <h2>Statistics</h2>
      <div className="tiles">
        <div className="tile">
          <div className="tile-value">{s.true_retention == null ? "—" : `${(s.true_retention * 100).toFixed(1)}%`}</div>
          <div className="tile-label">true retention, 30 days ({s.mature_reviews} mature reviews)</div>
        </div>
        <div className="tile">
          <div className="tile-value">{reviews30}</div>
          <div className="tile-label">item reviews, 30 days</div>
        </div>
        <div className="tile">
          <div className="tile-value">{reads30}</div>
          <div className="tile-label">topic reads, 30 days</div>
        </div>
        <div className="tile">
          <div className="tile-value">{s.forecast_items[0] + s.forecast_topics[0]}</div>
          <div className="tile-label">due today</div>
        </div>
      </div>

      <section>
        <h3>Last 30 days</h3>
        <Bars
          series={[s.history.map((h) => h.pass), s.history.map((h) => h.again), s.history.map((h) => h.topics)]}
          labels={histLabels}
          colors={["var(--g3)", "var(--g1)", "var(--g4)"]}
        />
        <div className="legend small"><span className="dot" style={{ background: "var(--g3)" }} />passed <span className="dot" style={{ background: "var(--g1)" }} />again <span className="dot" style={{ background: "var(--g4)" }} />topics read</div>
      </section>

      <section>
        <h3>Next 30 days</h3>
        <Bars series={[s.forecast_items, s.forecast_topics]} labels={foreLabels} colors={["var(--accent)", "var(--g2)"]} />
        <div className="legend small"><span className="dot" style={{ background: "var(--accent)" }} />items <span className="dot" style={{ background: "var(--g2)" }} />topics</div>
      </section>

      <section>
        <h3>Priority protection</h3>
        <p className="muted small">How much of each priority band is overdue. The top bands should stay near zero; low priority is allowed to slip.</p>
        <table className="table">
          <thead>
            <tr><th>priority</th><th>active</th><th>overdue</th><th /></tr>
          </thead>
          <tbody>
            {s.protection.map((b) => {
              const pct = b.total ? b.overdue / b.total : 0;
              return (
                <tr key={b.label}>
                  <td>{b.label}</td>
                  <td className="mono">{b.total}</td>
                  <td className="mono">{b.overdue}</td>
                  <td className="meter-cell">
                    <div className="meter"><div style={{ width: `${pct * 100}%`, background: pct > 0.2 ? "var(--g1)" : "var(--g3)" }} /></div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section>
        <h3>Most productive sources</h3>
        <table className="table">
          <thead>
            <tr><th>source</th><th>extracts</th><th>items</th></tr>
          </thead>
          <tbody>
            {s.sources.map((r) => (
              <tr key={r.id}><td>{r.title}</td><td className="mono">{r.extracts}</td><td className="mono">{r.items}</td></tr>
            ))}
            {s.sources.length === 0 && <tr><td colSpan={3} className="muted">No extracts yet.</td></tr>}
          </tbody>
        </table>
      </section>

      <section>
        <h3>Collection</h3>
        <p className="small">{s.by_status.map(([st, n]) => `${n} ${st}`).join(" · ")}</p>
        <p className="muted small">
          FSRS: {s.optimized ? "parameters fitted to your history" : "default parameters"} · {s.training_samples} training samples (optimizer in Tools → Scheduling)
        </p>
      </section>
    </div>
  );
}
