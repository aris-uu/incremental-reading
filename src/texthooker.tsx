import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { loadPrefs } from "./prefs";

type Sink = (lines: string[], heading: string | null) => void;

/**
 * The texthooker: a WebSocket client for the hook (Textractor's websocket
 * extension, LunaTranslator, agent…; the address texthooker UIs use). It is
 * switched on for one topic at a time, and every line received is appended to
 * that topic. While the topic is open in the reader the lines go straight
 * into its editor (so extracting, clozing and the read point keep working);
 * otherwise they are written to the collection directly.
 */
export function useTexthooker(onWritten: () => void) {
  const [target, setTarget] = useState<{ id: number; title: string } | null>(null);
  const [status, setStatus] = useState<"off" | "connecting" | "connected" | "error">("off");
  const [count, setCount] = useState({ lines: 0, chars: 0 });
  const ws = useRef<WebSocket | null>(null);
  const targetRef = useRef(target);
  targetRef.current = target;
  const sinks = useRef(new Map<number, Sink>());
  const last = useRef("");
  /** A heading with the time starts each session in the topic. */
  const heading = useRef<string | null>(null);
  const pending = useRef<string[]>([]);
  const pendingHeading = useRef<string | null>(null);
  const flushTimer = useRef<number | undefined>(undefined);
  const onWrittenRef = useRef(onWritten);
  onWrittenRef.current = onWritten;

  const receive = useCallback((raw: string) => {
    let text = raw;
    // Some hooks send JSON ({ sentence } / { text }); most send plain text.
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === "object") text = String(j.sentence ?? j.text ?? j.message ?? raw);
    } catch {
      /* plain text */
    }
    const lines = text
      .replace(/\r/g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && l !== last.current);
    const t = targetRef.current;
    if (!lines.length || !t) return;
    last.current = lines[lines.length - 1];
    const h = heading.current;
    heading.current = null;
    setCount((c) => ({ lines: c.lines + lines.length, chars: c.chars + lines.reduce((n, l) => n + [...l].length, 0) }));
    const sink = sinks.current.get(t.id);
    if (sink) return sink(lines, h);
    // Topic not open: write to the collection, batched and a moment later, so
    // a reader that was just closed has finished saving first.
    pending.current.push(...lines);
    if (h) pendingHeading.current = pendingHeading.current ?? h;
    window.clearTimeout(flushTimer.current);
    flushTimer.current = window.setTimeout(() => {
      const batch = pending.current.splice(0);
      const head = pendingHeading.current;
      pendingHeading.current = null;
      const tt = targetRef.current;
      if (!batch.length || !tt) return;
      const live = sinks.current.get(tt.id);
      if (live) return live(batch, head);
      void api
        .appendLines(tt.id, batch, head)
        .then(() => onWrittenRef.current())
        .catch(() => {});
    }, 1500);
  }, []);

  const connect = useCallback(() => {
    try {
      ws.current?.close();
    } catch {
      /* already closed */
    }
    setStatus("connecting");
    let sock: WebSocket;
    try {
      sock = new WebSocket(loadPrefs().hookerUrl);
    } catch {
      setStatus("error");
      return;
    }
    ws.current = sock;
    sock.onopen = () => setStatus("connected");
    sock.onmessage = (ev) => typeof ev.data === "string" && receive(ev.data);
    sock.onclose = () => {
      if (ws.current !== sock) return;
      setStatus(targetRef.current ? "error" : "off");
      // Keep trying while a topic is hooked (the game or hook may start later).
      window.setTimeout(() => targetRef.current && ws.current === sock && connect(), 3000);
    };
  }, [receive]);

  /** Hook a topic (or unhook with null). */
  const hook = useCallback(
    (t: { id: number; title: string } | null) => {
      setTarget(t);
      targetRef.current = t;
      if (!t) {
        const s = ws.current;
        ws.current = null;
        try {
          s?.close();
        } catch {
          /* already closed */
        }
        setStatus("off");
        return;
      }
      heading.current = new Date().toLocaleString();
      last.current = "";
      setCount({ lines: 0, chars: 0 });
      if (!ws.current || ws.current.readyState > 1) connect();
    },
    [connect],
  );

  useEffect(
    () => () => {
      try {
        ws.current?.close();
      } catch {
        /* closed */
      }
    },
    [],
  );

  /** An open reader takes the lines for its topic. */
  const attach = useCallback((id: number, sink: Sink) => {
    sinks.current.set(id, sink);
    return () => {
      if (sinks.current.get(id) === sink) sinks.current.delete(id);
    };
  }, []);

  return { target, status, count, hook, attach, receive };
}

export type Texthooker = ReturnType<typeof useTexthooker>;
export const HookerContext = createContext<Texthooker | null>(null);
export const useHooker = () => useContext(HookerContext);
