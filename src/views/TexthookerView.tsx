import { useCallback, useEffect, useRef, useState } from "react";
import { api, type TreeNode } from "../api";
import { loadPrefs, savePrefs } from "../prefs";
import { LookupHover } from "../hover";
import { sentenceAround } from "../japanese";
import { MineDialog } from "./MineDialog";
import type { Notify } from "../notify";

export interface HookLine {
  id: number;
  text: string;
  at: number;
}

/** Idle time after which the reading timer pauses (as texthooker UIs do). */
const AFK_MS = 120_000;
const RECENT_KEY = "ir.hookerTargets";

/**
 * The texthooker session: a WebSocket client for the hook's websocket
 * (Textractor's websocket extension, LunaTranslator, agent…), writing every
 * line into a topic ("VN::Route") as it arrives. Lives in App so it keeps
 * running while you browse elsewhere.
 */
export function useTexthooker(onAppended: () => void) {
  const [target, setTarget] = useState<{ id: number; path: string } | null>(null);
  const [lines, setLines] = useState<HookLine[]>([]);
  const [status, setStatus] = useState<"off" | "connecting" | "connected" | "error">("off");
  const [paused, setPaused] = useState(false);
  const [activeMs, setActiveMs] = useState(0);
  const ws = useRef<WebSocket | null>(null);
  const want = useRef(false);
  const lastAt = useRef(0);
  const heading = useRef<string | null>(null);
  const targetRef = useRef(target);
  targetRef.current = target;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const nextId = useRef(1);
  const lastText = useRef("");
  const onAppendedRef = useRef(onAppended);
  onAppendedRef.current = onAppended;

  /** Add lines (from the socket or pasted) to the view and the topic. */
  const receive = useCallback((raw: string[]) => {
    if (pausedRef.current) return;
    const now = Date.now();
    const clean: string[] = [];
    // Hooks often send the same line twice (repeated hooks, redraws).
    for (const r of raw) {
      const t = r.replace(/\r/g, "").trim();
      if (!t || t === lastText.current) continue;
      lastText.current = t;
      clean.push(t);
    }
    if (!clean.length) return;
    const add: HookLine[] = clean.map((text) => ({ id: nextId.current++, text, at: now }));
    setLines((ls) => [...ls, ...add].slice(-2000));
    // Reading time: count the gap since the last line, unless it was an AFK break.
    if (lastAt.current) {
      const gap = now - lastAt.current;
      if (gap < AFK_MS) setActiveMs((m) => m + gap);
    }
    lastAt.current = now;
    const t = targetRef.current;
    if (!t) return;
    const h = heading.current;
    heading.current = null;
    void api
      .appendLines(t.id, clean, h)
      .then(() => onAppendedRef.current())
      .catch(() => {});
  }, []);

  const connect = useCallback(() => {
    want.current = true;
    const url = loadPrefs().hookerUrl;
    try {
      ws.current?.close();
    } catch {
      /* already closed */
    }
    setStatus("connecting");
    let sock: WebSocket;
    try {
      sock = new WebSocket(url);
    } catch {
      setStatus("error");
      return;
    }
    ws.current = sock;
    sock.onopen = () => setStatus("connected");
    sock.onmessage = (ev) => {
      const data = typeof ev.data === "string" ? ev.data : "";
      let text = data;
      // Some hooks send JSON ({ sentence } / { text }); most send plain text.
      try {
        const j = JSON.parse(data);
        if (j && typeof j === "object") text = j.sentence ?? j.text ?? j.message ?? data;
      } catch {
        /* plain text */
      }
      receive([String(text)]);
    };
    sock.onclose = () => {
      if (ws.current !== sock) return;
      setStatus(want.current ? "error" : "off");
      // Keep trying while wanted (the game or hook may not be running yet).
      if (want.current) window.setTimeout(() => want.current && ws.current === sock && connect(), 3000);
    };
  }, [receive]);

  const disconnect = useCallback(() => {
    want.current = false;
    try {
      ws.current?.close();
    } catch {
      /* already closed */
    }
    ws.current = null;
    setStatus("off");
  }, []);

  useEffect(() => () => disconnect(), [disconnect]);

  /** Write into this topic (creating "VN::Route" if needed); a heading marks the session. */
  const start = useCallback(async (path: string) => {
    const id = await api.ensureDeck(path);
    if (id == null) throw new Error("Give the session a title");
    setTarget({ id, path });
    setLines([]);
    setActiveMs(0);
    lastAt.current = 0;
    heading.current = new Date().toLocaleString();
    try {
      const recent: string[] = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
      localStorage.setItem(RECENT_KEY, JSON.stringify([path, ...recent.filter((p) => p !== path)].slice(0, 12)));
    } catch {
      /* not remembered */
    }
    return id;
  }, []);

  const chars = lines.reduce((n, l) => n + [...l.text].length, 0);
  return { target, lines, setLines, status, paused, setPaused, connect, disconnect, start, receive, chars, activeMs, stop: () => setTarget(null) };
}

export type Texthooker = ReturnType<typeof useTexthooker>;

interface Props {
  hooker: Texthooker;
  notify: Notify;
  onOpen: (id: number) => void;
}

const fmtDuration = (ms: number) => {
  const m = Math.floor(ms / 60000);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
};

export function TexthookerView({ hooker, notify, onOpen }: Props) {
  const { target, lines, status, paused } = hooker;
  const [vn, setVn] = useState(() => target?.path.split("::")[0] ?? "");
  const [route, setRoute] = useState(() => target?.path.split("::").slice(1).join("::") ?? "");
  const [url, setUrl] = useState(loadPrefs().hookerUrl);
  const [roots, setRoots] = useState<TreeNode[]>([]);
  const [paste, setPaste] = useState("");
  const [mining, setMining] = useState<{ sentence: string; start: number; end: number } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const recent: string[] = (() => {
    try {
      return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    } catch {
      return [];
    }
  })();

  useEffect(() => {
    api.getTree().then((t) => setRoots(t.filter((n) => n.parent_id == null && n.status === "active")));
  }, []);

  // Follow new lines unless the reader scrolled up.
  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const begin = async () => {
    const path = [vn.trim(), ...route.split("::").map((r) => r.trim())].filter(Boolean).join("::");
    if (!path) return notify("Type the VN's title first");
    try {
      await hooker.start(path);
      if (status === "off" || status === "error") hooker.connect();
      notify(`Lines go into “${path}”`);
    } catch (e) {
      notify(String(e));
    }
  };

  /** Alt+S on a selection inside a line: sentence card. */
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!ev.altKey || ev.key.toLowerCase() !== "s") return;
      const sel = window.getSelection();
      const node = sel?.anchorNode;
      const line = node?.parentElement?.closest(".hook-line") as HTMLElement | null;
      if (!sel || sel.isCollapsed || !line || !list.current?.contains(line)) return;
      ev.preventDefault();
      const text = line.querySelector(".hook-text")?.textContent ?? "";
      const r = sel.getRangeAt(0);
      const pre = document.createRange();
      pre.setStart(line.querySelector(".hook-text")!, 0);
      pre.setEnd(r.startContainer, r.startOffset);
      const from = pre.toString().length;
      setMining(sentenceAround(text, from, from + r.toString().length));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const speed = hooker.activeMs > 60_000 ? Math.round(hooker.chars / (hooker.activeMs / 3_600_000)) : null;

  return (
    <div className="hooker">
      <div className="hooker-bar">
        <span className={`dot ${status}`} title={status} />
        <input className="hooker-url" value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => savePrefs({ ...loadPrefs(), hookerUrl: url.trim() })} title="The hook's WebSocket (Textractor websocket extension, LunaTranslator, agent…)" />
        {status === "connected" || status === "connecting" ? (
          <button onClick={hooker.disconnect}>Disconnect</button>
        ) : (
          <button onClick={() => (savePrefs({ ...loadPrefs(), hookerUrl: url.trim() }), hooker.connect())}>Connect</button>
        )}
        <button className={paused ? "active" : ""} onClick={() => hooker.setPaused(!paused)} title="Ignore incoming lines (menus, skipping)">
          {paused ? "▶ Resume" : "⏸ Pause"}
        </button>
        <span className="spacer" />
        <span className="small muted mono" title="Characters this session · active reading time (pauses after 2 min idle) · speed">
          {hooker.chars.toLocaleString()} chars · {fmtDuration(hooker.activeMs)}
          {speed != null && ` · ${speed.toLocaleString()} chars/h`}
        </span>
      </div>
      <div className="hooker-bar">
        <input list="hooker-vns" placeholder="VN title" value={vn} onChange={(e) => setVn(e.target.value)} />
        <datalist id="hooker-vns">
          {roots.map((r) => (
            <option key={r.id} value={r.title} />
          ))}
        </datalist>
        <input placeholder="route / chapter (optional; a::b nests)" value={route} onChange={(e) => setRoute(e.target.value)} />
        <button className="primary" onClick={() => void begin()}>{target ? "Switch" : "Start"}</button>
        {target && (
          <>
            <span className="small">→ <a onClick={() => onOpen(target.id)}>{target.path}</a></span>
            <button className="small-btn" onClick={hooker.stop} title="Stop writing lines into the topic (they still show here)">Stop writing</button>
          </>
        )}
        {!target && recent.length > 0 && (
          <select
            className="small"
            value=""
            onChange={(e) => {
              const [v, ...r] = e.target.value.split("::");
              setVn(v);
              setRoute(r.join("::"));
            }}
          >
            <option value="">Recent…</option>
            {recent.map((p) => (
              <option key={p} value={p}>{p.replace(/::/g, " › ")}</option>
            ))}
          </select>
        )}
      </div>
      <div
        className="hook-lines"
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {lines.length === 0 && (
          <div className="muted pad small">
            <p>
              Waiting for text. Run your hook (Textractor with its WebSocket extension, LunaTranslator, agent, …) and connect to its WebSocket
              address above. Each line is shown here and written into the session's topic, so you can reread, extract and mine it later.
            </p>
            <p>Hold <kbd>Shift</kbd> over text for the dictionary popup (Yomitan API). Select a word and press <kbd>Alt+S</kbd> for a sentence card.</p>
          </div>
        )}
        {lines.map((l) => (
          <div key={l.id} className="hook-line">
            <span className="hook-text">{l.text}</span>
            <button className="small-btn hook-x" title="Hide this line (it stays in the topic)" onClick={() => hooker.setLines((ls) => ls.filter((x) => x.id !== l.id))}>×</button>
          </div>
        ))}
      </div>
      <div className="hooker-bar">
        <textarea
          rows={1}
          placeholder="…or paste lines here (Enter adds them)"
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              hooker.receive(paste.split("\n"));
              setPaste("");
            }
          }}
        />
      </div>
      <LookupHover container={list} sourceId={target?.id ?? null} sourceTitle={target?.path.replace(/::/g, " › ") ?? "Texthooker"} notify={notify} />
      {mining && (
        <MineDialog
          {...mining}
          sourceId={target?.id ?? null}
          sourceTitle={target?.path.replace(/::/g, " › ") ?? "Texthooker"}
          notify={notify}
          onClose={() => setMining(null)}
          onCreated={() => setMining(null)}
        />
      )}
    </div>
  );
}
