import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { api, fmtTime, type ElementFull } from "../api";
import { loadYouTubeApi, watchUrl } from "../youtube";
import type { Notify } from "../notify";

export interface VideoHandle {
  seek: (t: number) => void;
  time: () => number;
}

interface Props {
  element: ElementFull;
  notify: Notify;
  /** Create a clip extract for start..end (seconds). */
  onClip: (start: number, end: number) => Promise<void>;
}

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

/**
 * Incremental video: the YouTube player for a video topic or clip. The resume
 * position is saved like a read point; marking a start and an end makes a
 * clip extract (a child topic that plays just that part).
 */
export const VideoPanel = forwardRef<VideoHandle, Props>(function VideoPanel({ element, notify, onClip }, ref) {
  const t = element.topic!;
  const id = element.id;
  const videoId = t.video_id!;
  const clip = t.video_start != null && t.video_end != null ? { start: t.video_start, end: t.video_end } : null;
  const resume = (() => {
    const p = t.video_pos ?? clip?.start ?? 0;
    return clip && (p < clip.start || p >= clip.end - 1) ? clip.start : p;
  })();

  const host = useRef<HTMLDivElement>(null);
  const player = useRef<any>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(resume);
  const [mark, setMark] = useState<number | null>(null);
  const lastSaved = useRef(resume);

  const current = useCallback(() => {
    try {
      return player.current?.getCurrentTime?.() ?? now;
    } catch {
      return now;
    }
  }, [now]);

  const savePos = useCallback(
    (pos: number) => {
      if (Math.abs(pos - lastSaved.current) < 1) return;
      lastSaved.current = pos;
      void api.setVideoPos(id, pos);
    },
    [id],
  );

  useEffect(() => {
    let cancelled = false;
    loadYouTubeApi()
      .then((YT) => {
        if (cancelled || !host.current) return;
        const div = document.createElement("div");
        host.current.replaceChildren(div);
        player.current = new YT.Player(div, {
          videoId,
          width: "100%",
          height: "100%",
          playerVars: {
            start: Math.floor(resume),
            ...(clip ? { end: Math.ceil(clip.end) } : {}),
            rel: 0,
            modestbranding: 1,
            playsinline: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: () => !cancelled && setReady(true),
            onError: (e: any) =>
              !cancelled &&
              setError(
                [101, 150, 153].includes(e?.data)
                  ? "This video can't be played inside the app."
                  : `The player reported error ${e?.data}.`,
              ),
          },
        });
      })
      .catch((e) => !cancelled && setError(String(e.message ?? e)));
    return () => {
      cancelled = true;
      try {
        const pos = player.current?.getCurrentTime?.();
        if (typeof pos === "number") {
          lastSaved.current = -10;
          savePos(pos);
        }
        player.current?.destroy?.();
      } catch {
        /* player already gone */
      }
      player.current = null;
    };
    // The player is created once per element.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, id]);

  // Track the time; stop at the end of a clip; save the position now and then.
  useEffect(() => {
    if (!ready) return;
    const timer = window.setInterval(() => {
      const p = player.current;
      if (!p?.getCurrentTime) return;
      const pos = p.getCurrentTime();
      setNow(pos);
      if (clip && pos >= clip.end && p.getPlayerState?.() === 1) p.pauseVideo();
      if (Math.abs(pos - lastSaved.current) >= 10) savePos(pos);
    }, 400);
    return () => window.clearInterval(timer);
  }, [clip, ready, savePos]);

  const seek = useCallback((s: number) => {
    const p = player.current;
    if (!p?.seekTo) return;
    p.seekTo(Math.max(0, s), true);
    p.playVideo?.();
    setNow(s);
  }, []);

  useImperativeHandle(ref, () => ({ seek, time: current }), [current, seek]);

  const togglePlay = useCallback(() => {
    const p = player.current;
    if (!p?.getPlayerState) return;
    p.getPlayerState() === 1 ? p.pauseVideo() : p.playVideo();
  }, []);

  const markStart = useCallback(() => {
    const s = current();
    setMark(s);
    notify(`Clip start at ${fmtTime(s)} — play on, then mark the end (Alt+E)`);
  }, [current, notify]);

  const markEnd = useCallback(async () => {
    const e = current();
    const s = mark ?? Math.max(clip?.start ?? 0, e - 30);
    if (e - s < 1) return notify("The clip end must come after its start");
    try {
      await onClip(s, e);
      setMark(null);
    } catch (err) {
      notify(String(err));
    }
  }, [clip, current, mark, notify, onClip]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!ev.altKey || ev.ctrlKey || isTyping(ev.target)) return;
      const k = ev.key.toLowerCase();
      const run = (f: () => unknown) => (ev.preventDefault(), void f());
      if (k === "k") run(togglePlay);
      else if (k === "b") run(markStart);
      else if (k === "e") run(markEnd);
      else if (k === "arrowleft") run(() => seek(current() - 10));
      else if (k === "arrowright") run(() => seek(current() + 10));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, markEnd, markStart, seek, togglePlay]);

  return (
    <div className="video-panel">
      <div className="video-frame">
        <div ref={host} className="video-host" />
        {error && (
          <div className="video-error">
            <p>{error}</p>
            <a href={watchUrl(videoId, now)} target="_blank" rel="noreferrer">
              Open on YouTube at {fmtTime(now)}
            </a>
          </div>
        )}
      </div>
      <div className="video-controls small">
        <button className="small-btn" onClick={togglePlay} disabled={!ready} title="Alt+K">⏯</button>
        <button className="small-btn" onClick={() => seek(current() - 10)} disabled={!ready} title="Alt+←">−10s</button>
        <button className="small-btn" onClick={() => seek(current() + 10)} disabled={!ready} title="Alt+→">+10s</button>
        <span className="mono">{fmtTime(now)}</span>
        {clip && (
          <>
            <span className="chip">clip {fmtTime(clip.start)}–{fmtTime(clip.end)}</span>
            <button className="small-btn" onClick={() => seek(clip.start)} disabled={!ready}>Replay clip</button>
          </>
        )}
        <span className="spacer" />
        <button className="small-btn" onClick={markStart} disabled={!ready} title="Alt+B">
          [ Start{mark != null ? ` ${fmtTime(mark)}` : ""}
        </button>
        <button className="small-btn" onClick={() => void markEnd()} disabled={!ready} title="Alt+E — clip from the start mark (or the last 30 s) to here">
          ] End → clip
        </button>
        <a className="small" href={watchUrl(videoId, now)} target="_blank" rel="noreferrer" title="Open in the browser at this time">
          YouTube ↗
        </a>
      </div>
    </div>
  );
});
