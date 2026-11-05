import { useCallback, useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Readability } from "@mozilla/readability";
import { api } from "../api";
import { EMPTY_DOC, extensions, htmlToDoc } from "../editor/extensions";
import { COLLECTION_CHANGED } from "../importWindow";
import { FormatBar } from "../editor/FormatBar";
import { SUPPORTED, importFiles } from "../importers";
import { fetchVideoInfo, parsePastedTranscript, youtubeId, youtubeStart } from "../youtube";

/** Extract the readable article from a fetched page. */
function readable(html: string, url: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // Resolve relative links and images against the page URL.
  const base = doc.createElement("base");
  base.href = url;
  doc.head.prepend(base);
  return new Readability(doc).parse();
}

/**
 * Contents of the separate import window. Paste an article (rich HTML from a
 * browser keeps formatting) or fetch a URL, review it, and add it.
 */
export function ImportView() {
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [site, setSite] = useState<string | null>(null);
  const [author, setAuthor] = useState<string | null>(null);
  const [priority, setPriority] = useState(50);
  const [toInbox, setToInbox] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editor = useEditor({ extensions, content: EMPTY_DOC, autofocus: true });
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  /** Set when the URL is a YouTube video: the topic becomes an incremental video. */
  const [video, setVideo] = useState<{ id: string; start: number } | null>(null);

  /** PDFs, EPUBs, HTML, Markdown and text files; folders keep their structure. */
  const importFileList = useCallback(
    async (list: FileList | File[] | null) => {
      const files = [...(list ?? [])];
      if (!files.length) return;
      setBusy(true);
      try {
        const n = await importFiles(files, { priority, parent: null, inbox: toInbox, onProgress: setStatus });
        await emit(COLLECTION_CHANGED);
        const skipped = files.length - n;
        setStatus(`Imported ${n} file${n === 1 ? "" : "s"}${skipped ? `, skipped ${skipped} unsupported` : ""}. Folder and book imports are spread over the coming days.`);
      } catch (e) {
        setStatus(`Import failed: ${e}`);
      } finally {
        setBusy(false);
      }
    },
    [priority, toInbox],
  );

  const fetchUrl = useCallback(async () => {
    const u = url.trim();
    if (!editor || !u) return setStatus("Enter a URL first.");
    setBusy(true);
    setStatus("Fetching…");
    const vid = youtubeId(u);
    if (vid) {
      try {
        const info = await fetchVideoInfo(vid);
        editor.commands.setContent(info.transcript ?? EMPTY_DOC);
        setTitle(info.title);
        setAuthor(info.author);
        setSite("YouTube");
        setVideo({ id: vid, start: youtubeStart(u) });
        setStatus(
          info.transcript
            ? `Video with a ${info.language ?? ""} transcript. Extract and cloze from the text; timestamps jump the player.`
            : "No transcript fetched. Paste YouTube's “Show transcript” text below and click “Link pasted transcript”, or add the video alone.",
        );
      } catch (e) {
        setStatus(`Fetch failed: ${e}`);
      } finally {
        setBusy(false);
      }
      return;
    }
    setVideo(null);
    try {
      const page = await api.fetchPage(u);
      const article = readable(page.html, page.final_url);
      if (!article?.content) throw new Error("Couldn't find an article on that page");
      editor.commands.setContent(htmlToDoc(article.content));
      setTitle(article.title ?? "");
      setSite(article.siteName ?? null);
      setAuthor(article.byline ?? null);
      setUrl(page.final_url);
      setStatus(`Fetched ${(article.length ?? 0).toLocaleString()} characters. Trim anything you don't want, then add.`);
    } catch (e) {
      setStatus(`Fetch failed: ${e}`);
    } finally {
      setBusy(false);
    }
  }, [editor, url]);

  const submit = useCallback(
    async (close: boolean) => {
      if (!editor || (editor.isEmpty && !video)) return setStatus("Paste or fetch some content first.");
      setBusy(true);
      setStatus("Saving (downloading images)…");
      try {
        const newId = await api.importTopic({
          title: title.trim(),
          doc_json: JSON.stringify(editor.getJSON()),
          priority,
          url: url.trim() || null,
          site,
          author,
          inbox: toInbox,
          video_id: video?.id ?? null,
        });
        if (video?.start) await api.setVideoPos(newId, video.start);
      } catch (e) {
        setBusy(false);
        return setStatus(`Import failed: ${e}`);
      }
      await emit(COLLECTION_CHANGED);
      setBusy(false);
      if (close) return void getCurrentWindow().close();
      const shown = title.trim() || "article";
      editor.commands.setContent(EMPTY_DOC);
      setTitle("");
      setUrl("");
      setSite(null);
      setAuthor(null);
      setVideo(null);
      setStatus(toInbox ? `Added “${shown}” to the Inbox.` : `Added “${shown}”. It is due today.`);
      editor.commands.focus();
    },
    [author, editor, priority, site, title, toInbox, url, video],
  );

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.ctrlKey && ev.key === "Enter") ev.preventDefault(), void submit(ev.shiftKey);
      else if (ev.key === "Escape") void getCurrentWindow().close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [submit]);

  return (
    <div
      className={`import ${dragging ? "dragging" : ""}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        void importFileList(e.dataTransfer.files);
      }}
    >
      <div className="form-row">
        <input
          placeholder="https://… (an article or a YouTube video) or leave empty and paste below"
          value={url}
          onChange={(e) => (setUrl(e.target.value), setVideo(null))}
          onKeyDown={(e) => e.key === "Enter" && !e.ctrlKey && void fetchUrl()}
        />
        <button disabled={busy} onClick={fetchUrl}>Fetch</button>
        <button disabled={busy} onClick={() => filesRef.current?.click()} title={SUPPORTED.join(", ")}>Files…</button>
        <button disabled={busy} onClick={() => folderRef.current?.click()} title="Import a folder; subfolders become topics">Folder…</button>
        <input ref={filesRef} type="file" multiple hidden accept={SUPPORTED.map((e) => `.${e}`).join(",")} onChange={(e) => (importFileList(e.target.files), (e.target.value = ""))} />
        <input
          ref={folderRef}
          type="file"
          hidden
          // @ts-expect-error non-standard but supported by Chromium/WebView2
          webkitdirectory=""
          onChange={(e) => (importFileList(e.target.files), (e.target.value = ""))}
        />
      </div>
      <div className="form-row">
        <input placeholder="Title (defaults to first line)" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="form-row">
        <label className="priority" title="0 = most important, 100 = least">
          Priority
          <input type="range" min={0} max={100} value={priority} onChange={(e) => setPriority(Number(e.target.value))} />
          <span className="mono">{priority}%</span>
        </label>
        <label className="check" title="Triage later instead of adding to today's queue">
          <input type="checkbox" checked={toInbox} onChange={(e) => setToInbox(e.target.checked)} /> to Inbox
        </label>
        <span className="spacer" />
        {video && <span className="chip">▶ incremental video</span>}
        {video && (
          <button
            className="small-btn"
            title="Paste the text from YouTube's “Show transcript” panel below, then click to turn its timestamps into links"
            onClick={() => {
              const doc = editor && parsePastedTranscript(editor.getText({ blockSeparator: "\n" }));
              if (!doc) return setStatus("No timestamps found. Paste the transcript text (with its 0:00 times) first.");
              editor!.commands.setContent(doc);
              setStatus("Transcript linked: timestamps now jump the player.");
            }}
          >
            Link pasted transcript
          </button>
        )}
        {(site || author) && <span className="muted small">{[site, author].filter(Boolean).join(" · ")}</span>}
      </div>
      <FormatBar editor={editor} />
      <div className="reader paste-box" onClick={() => editor?.commands.focus()}>
        <EditorContent editor={editor} />
      </div>
      <footer className="actions">
        <button className="primary" disabled={busy} onClick={() => submit(false)}>
          Add <kbd>Ctrl+Enter</kbd>
        </button>
        <button disabled={busy} onClick={() => submit(true)}>
          Add &amp; close <kbd>Ctrl+Shift+Enter</kbd>
        </button>
        <span className="spacer" />
        <span className="small muted">{status}</span>
        <button onClick={() => getCurrentWindow().close()}>Close <kbd>Esc</kbd></button>
      </footer>
    </div>
  );
}
