import { api, fmtTime } from "./api";

/** The 11-character video id from any common YouTube URL form, or null. */
export function youtubeId(url: string): string | null {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.replace(/^(www|m|music)\./, "");
    let id: string | null = null;
    if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0];
    else if (host === "youtube.com" || host === "youtube-nocookie.com") {
      if (u.pathname === "/watch") id = u.searchParams.get("v");
      else {
        const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/);
        id = m?.[1] ?? null;
      }
    }
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** Start time from `?t=` / `&start=` (e.g. 90, 90s, 1m30s), in seconds. */
export function youtubeStart(url: string): number {
  try {
    const u = new URL(url.trim());
    const t = u.searchParams.get("t") ?? u.searchParams.get("start");
    if (!t) return 0;
    if (/^\d+$/.test(t)) return Number(t);
    const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
  } catch {
    return 0;
  }
}

export const watchUrl = (id: string, at = 0) => `https://www.youtube.com/watch?v=${id}${at > 0 ? `&t=${Math.floor(at)}s` : ""}`;

interface Cue {
  start: number;
  text: string;
}

/** Find the JSON array that follows `key` in a page (bracket matching). */
function jsonArrayAfter(html: string, key: string): any[] | null {
  const i = html.indexOf(key);
  if (i < 0) return null;
  const start = html.indexOf("[", i);
  let depth = 0;
  let inStr = false;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (c === "\\") j++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, j + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Parse YouTube's timedtext XML (format 1 `<text start>` or format 3 `<p t>`). */
function parseTimedText(xml: string): Cue[] {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const decode = (s: string) => {
    const el = document.createElement("textarea");
    el.innerHTML = s;
    return el.value;
  };
  const cues: Cue[] = [];
  for (const n of doc.querySelectorAll("text")) cues.push({ start: Number(n.getAttribute("start") ?? 0), text: decode(n.textContent ?? "") });
  if (!cues.length) for (const n of doc.querySelectorAll("p")) cues.push({ start: Number(n.getAttribute("t") ?? 0) / 1000, text: decode(n.textContent ?? "") });
  return cues.map((c) => ({ ...c, text: c.text.replace(/\s+/g, " ").trim() })).filter((c) => c.text);
}

export interface VideoInfo {
  id: string;
  title: string;
  author: string | null;
  /** Transcript as a document: paragraphs of ~30 s, each led by a timestamp link. */
  transcript: any | null;
  language: string | null;
}

/**
 * Title, channel and (best effort) transcript. YouTube changes its pages
 * often; when the transcript can't be read the topic is the video alone,
 * and a transcript can still be pasted in by hand.
 */
export async function fetchVideoInfo(id: string): Promise<VideoInfo> {
  let title = `YouTube ${id}`;
  let author: string | null = null;
  try {
    const o = JSON.parse((await api.fetchPage(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watchUrl(id))}`)).html);
    title = o.title ?? title;
    author = o.author_name ?? null;
  } catch {
    /* keep the fallback title */
  }
  let transcript: any = null;
  let language: string | null = null;
  try {
    const page = await api.fetchPage(`${watchUrl(id)}&hl=en`);
    const tracks = jsonArrayAfter(page.html, '"captionTracks":') ?? [];
    // Prefer English written captions, then English auto captions, then anything.
    const score = (t: any) => (String(t.languageCode).startsWith("en") ? 2 : 0) + (t.kind === "asr" ? 0 : 1);
    const track = [...tracks].sort((a, b) => score(b) - score(a))[0];
    if (track?.baseUrl) {
      const xml = (await api.fetchPage(track.baseUrl)).html;
      const cues = parseTimedText(xml);
      if (cues.length) {
        transcript = transcriptDoc(cues);
        language = track.languageCode ?? null;
      }
    }
  } catch {
    /* no transcript */
  }
  return { id, title, author, transcript, language };
}

/** Group cues into ~30-second paragraphs that start with a `[m:ss]` link. */
export function transcriptDoc(cues: Cue[], every = 30) {
  const paras: { start: number; text: string[] }[] = [];
  for (const c of cues) {
    const last = paras[paras.length - 1];
    const sentenceEnd = last && /[.!?]$/.test(last.text[last.text.length - 1] ?? "");
    if (!last || c.start - last.start >= every * (sentenceEnd ? 1 : 1.6)) paras.push({ start: c.start, text: [c.text] });
    else last.text.push(c.text);
  }
  return {
    type: "doc",
    content: paras.map((p) => ({
      type: "paragraph",
      content: [
        { type: "text", text: `[${fmtTime(p.start)}]`, marks: [{ type: "link", attrs: { href: `#t=${Math.floor(p.start)}` } }] },
        { type: "text", text: " " + p.text.join(" ") },
      ],
    })),
  };
}

/**
 * Transcript text copied from YouTube's "Show transcript" panel: timestamps
 * (`1:23` or `1:02:03`) on their own lines or at line starts, text after them.
 * Returns null if it doesn't look like one.
 */
export function parsePastedTranscript(text: string) {
  const cues: Cue[] = [];
  const stamp = /^\s*(?:(\d+):)?(\d{1,2}):(\d{2})\s*(.*)$/;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(stamp);
    if (m) cues.push({ start: Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]), text: m[4].trim() });
    else if (cues.length && line.trim()) {
      const last = cues[cues.length - 1];
      last.text = `${last.text} ${line.trim()}`.trim();
    }
  }
  const good = cues.filter((c) => c.text);
  return good.length >= 3 ? transcriptDoc(good) : null;
}

/** Seconds from a transcript timestamp link (`#t=123`), or null. */
export const timeFromHref = (href: string | null | undefined) => {
  const m = href?.match(/^#t=(\d+(?:\.\d+)?)$/);
  return m ? Number(m[1]) : null;
};

// ---------- IFrame player ----------

declare global {
  interface Window {
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<any> | null = null;

/** Load the YouTube IFrame API once. */
export function loadYouTubeApi(): Promise<any> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve(window.YT);
    };
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.onerror = () => {
      apiPromise = null;
      reject(new Error("Couldn't load the YouTube player (offline?)"));
    };
    document.head.appendChild(s);
  });
  return apiPromise;
}
