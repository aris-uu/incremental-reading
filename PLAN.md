# Modern Incremental Reading — Brainstorm & Plan

Status: draft for discussion (2026-11-04). Nothing is built yet.

## 1. What incremental reading actually is

Distilled from supermemo.guru and help.supermemo.org:

**The funnel:** a large pile of material → a personal selection → **extracts** (key passages) → **clozes** (active recall) → stable memory through spaced repetition → creative use.

**The loop:** "Learn" hands you the next element from one priority-sorted queue. It may be:
- a **topic** (an article or extract): you read a little, extract, maybe cloze, set a read point, and move on; or
- an **item** (a cloze or Q&A): you recall it, grade it, and move on.

Being interrupted is part of the method. You leave an article half-read when you get bored, run out of time, don't understand it, or decide it isn't important enough. It comes back later on a growing interval.

**The minimum definition** (SuperMemo's own checklist of what software must have to count as incremental reading):

| Required | Notes for us |
|---|---|
| Spaced repetition | FSRS for items |
| Extracts | Child elements that keep a link back to their source |
| Cloze deletions | Made from short extracts |
| Read points | A bookmark for each topic |
| Priority queue | Global ordering of everything |
| Auto-sort + auto-postpone | Automatic triage of the daily queue |
| Extract/cloze hierarchy (knowledge tree) | Needed for reviewing by subject |
| Easy web import (HTML + images) | Browser extension |
| Rich WYSIWYG formatting | Rich-text document model |
| Propagating images and references | Children inherit their source's context |
| Mid-interval review with spacing correction | FSRS handles this natively |
| Early review (advance, add to outstanding) | |
| Semantic review (search, branch, subset) | |
| Overload tools (Mercy, Postpone) | |
| Image download/localization | Images stored locally |

These are optional in SuperMemo but worth having: A-Factor topic scheduling, ignore/highlight marks, splitting articles automatically, bulk folder import, site filters, video/audio, **PDF** (which SuperMemo itself handles badly), and statistics.

## 2. What is wrong with SuperMemo (SM18/SM20) that we should fix

1. **The UI is from 1995.** It uses many floating windows, modal dialogs, and over 100 shortcuts with no command palette, and it takes months to learn.
2. **It is Windows-only and desktop-only.** You can't review on your phone or read on a tablet.
3. **Imports are fragile.** Web import depends on IE/Chrome hooks, HTML filtering is manual (F6), and there is no real PDF or EPUB support.
4. **It copies text instead of linking it.** An extract is a copy of the passage. The parent only shows a color, and finding where an extract came from is clumsy.
5. **Scheduling is opaque.** Priority percentages drift, "Priority protection" is hidden in statistics, and you can't see why an element is in today's queue.
6. **New material has no triage.** Imports go straight into the queue, so you end up with a backlog of thousands of unread topics.
7. **The algorithm is proprietary.** SM-17/18/20 can't be inspected. FSRS is open, has been validated on a large benchmark, and comes with an optimizer.

## 3. Platform: web, desktop, or both?

| Option | Pros | Cons |
|---|---|---|
| **Hosted web app (SaaS)** | Zero install; works everywhere | Needs a server, accounts, hosting cost, and a privacy story. Copyright gets messy when you store users' imported articles. Offline use is weak. |
| **Pure native desktop** | Fast; full filesystem access | Doesn't solve mobile; a separate codebase for every OS |
| **Electron** | Mature; full Chromium for PDF and rich text | Heavy (about 150 MB); Node runs alongside |
| **Tauri 2 (Rust + system WebView) + local SQLite** ⭐ | Small and fast. Rust lets us use **fsrs-rs**, the reference FSRS implementation and optimizer. Real SQLite. Tauri 2 also targets **Android and iOS** with the same UI. | WebView differences between platforms; mobile support is younger |
| **PWA with SQLite-WASM (OPFS)** | Runs in any browser; no install | Storage can be evicted; limited file and PDF handling; awkward to integrate with a browser extension |

### Recommendation: local-first Tauri app with a TypeScript UI, plus a browser extension for capture

- **Local-first:** your library is a SQLite file you own. It works offline, has no server, and needs no account. Sync comes later as an add-on, not a prerequisite.
- **One UI codebase (React + TypeScript)** for desktop now and Tauri mobile later. The mobile app focuses on item review and light reading. Heavy extracting stays on desktop or tablet.
- **The browser extension (MV3)** is the "Import" button. It runs Mozilla Readability on the current page, downloads images, and sends the article to the app. A local HTTP or native-messaging bridge carries the data, and the article lands in the **Inbox**.
- **Rust core:** database, FSRS (`fsrs-rs`), queue building, auto-postpone, and import pipelines. The UI calls it through Tauri commands. The core stays independent of the UI, so a CLI or headless sync server can reuse it.

## 4. Scheduling design

### Items: FSRS
- Use **fsrs-rs** in the core (or `ts-fsrs` if we prototype in the UI first).
- Each item stores stability, difficulty, due date, reps, lapses, and state. Every grade is written to `review_log`, so the **optimizer** can retrain parameters from your own history (once you have about 1,000 reviews).
- Grading uses the standard 4 buttons (Again/Hard/Good/Easy). We could offer a 2-button mode.
- **Mid-interval and early review:** FSRS already computes stability updates from the actual elapsed time, which covers the "spacing-effect correction" requirement for free.
- **Desired retention** can be set per collection. We could also derive it from priority: high-priority items get 0.95, low-priority ones 0.85. This is a modern way to express "priority protection".

### Topics: A-Factor scheduler (not FSRS)
Topics are read, not recalled, so FSRS's memory model doesn't apply.
- `next_interval = interval × afactor`, where the A-Factor starts around 1.2–2.0. It is lower for short or high-priority texts and higher for long or low-priority ones.
- Actions in the reader adjust it: "Too long → later", "Read more often", "Postpone 100 days" (for when you don't understand).
- A new extract inherits its parent's priority, adjusted by a small amount, and starts on a short interval (1–3 days).

### Priority queue
- Internally, priority is a **fractional rank**, a float that is cheap to insert between two neighbors. The UI shows it as a **percentile from 0 to 100%**, where lower means more important, keeping SuperMemo's convention.
- **The daily queue** is built at the first open each day:
  1. Collect everything due (items and topics), plus outstanding elements added "for later today".
  2. **Auto-sort** by priority, with some randomization so the same items aren't always at the front.
  3. **Auto-postpone:** if the load is over your daily budget (in minutes or counts), postpone the lowest-priority elements first. For items, this is **FSRS-aware**: an item is only postponed while its predicted retrievability on the new date stays above a floor. Topics are simply pushed out.
  4. **Interleave** topics and items at a configurable ratio (SuperMemo suggests 3–8 items per topic).
- **Mercy:** spread a backlog over N days, or front-load before a vacation.
- **"Why is this here?"**: every element shows its due date, priority, its rank in the queue, and whether it was postponed.

## 5. Document model: the core technical decision

Use **ProseMirror** (via TipTap) as the rich-text model for every topic.

- A **source** holds the imported content (sanitized HTML converted to ProseMirror JSON) and its **reference** (title, author, URL, date, and optionally a PDF page).
- **Marks** on the text: `extracted(childId)`, `clozed(itemId)`, `ignored`, and `highlight`. Clicking an extracted span jumps to its child element.
- An **extract** is a new topic element whose content is a *copy* of the selected fragment. Copying lets you edit it freely to add context. Its `parent_id` and `source_range` keep the link back to the original.
- A **cloze** is an item with the sentence text, the deletion ranges, and an optional hint. **References and images propagate** from the parent chain when the card is displayed, rather than being copied into every item.
- **Read point:** a ProseMirror position stored on the topic, with an anchor quote as a fallback in case the text was edited.
- **"Done!":** deletes the topic's body but keeps the element as an empty node, so its children stay in the tree. "Delete before cursor" is the quick way to trim what you've read.
- **PDF** (phase 2): render with pdf.js. An extract carries the selected text *plus* an image of the selected region, so formulas and figures survive. **EPUB** is converted to HTML per chapter. **YouTube**: the transcript becomes the topic, and extracts become timestamped clips.

## 6. Data model (SQLite, first sketch)

```
element        id, kind(source|topic|item), parent_id, source_id, title,
               priority_rank REAL, status(inbox|active|done|dismissed),
               created_at, updated_at
topic_content  element_id, doc_json, read_point, afactor, interval,
               due, last_read
item_card      element_id, item_type(cloze|qa|occlusion), front_json,
               back_json, fsrs_stability, fsrs_difficulty, due, reps,
               lapses, state, last_review
review_log     id, element_id, ts, kind(read|grade|postpone|reschedule),
               grade, elapsed_days, prev/next interval, duration_ms
source_ref     element_id, url, author, published, site, accessed_at
asset          id, sha256, mime, path   -- localized images and PDFs
tag / concept  id, name;  element_tag(element_id, tag_id)
settings       key, value
```
- The tree comes from **derivation** (`parent_id`: source → extract → sub-extract → cloze). **Concepts and tags** organize things across sources, playing the role of SuperMemo's concept groups.
- The full-text search index is SQLite **FTS5**. Embeddings for "neural review" (vector search) come later.
- An append-only `review_log` makes stats, the FSRS optimizer, and undo straightforward.

## 7. Interface

Principles: **one screen, keyboard-first, a command palette (Ctrl+K)**, and no floating windows. Optional shortcut presets: "Modern" (default) or "SuperMemo" (Alt+X, Alt+Z, Ctrl+J, and so on) for people coming from SuperMemo.

**Main areas:**

1. **Learn (the queue):** a focused reading view.
   - Top bar: today's progress (`23 / 140 · 38 min left`), element type, priority, and interval.
   - Body: the topic, with the read point marked and extracted, clozed, and ignored spans visibly styled.
   - Floating selection toolbar: **Extract (X)** · **Cloze (Z)** · Ignore · Highlight.
   - Footer: **Next (Enter)** · Later today · Reschedule · Priority ±· **Done!** · Dismiss.
   - Items swap in a recall card: Show answer (Space), then a 1–4 grade, with the reference and source link underneath.
2. **Inbox (triage):** this doesn't exist in SuperMemo. New imports land here. You quickly set a priority (drag, or 1–9) or discard. Only triaged material enters the queue, which stops a backlog from building up.
3. **Library / Tree:** sources and their derivation trees, plus concepts and tags. Filter or search, then run **subset review** on any selection, such as a branch or a search result before an exam.
4. **Element panel** (a side drawer): history, children, schedule details, the "why it's here" explanation, and the reference.
5. **Stats:** daily load forecast, retention compared with target, "priority protection" (how much of the top-priority material is being processed on time), and how many items have come out of each source.

**Possible AI assists** (optional and off by default; IR's value comes from processing the material yourself):
- "Make extract standalone": suggests the missing context, for example replacing a pronoun with the noun it refers to.
- Cloze keyword suggestions.
- Semantic "related elements" shown in the panel.
These would run locally or through an API key you supply.

## 8. Phased roadmap

**Phase 0: Spike (1–2 weeks)**
- Tauri + React + TipTap shell with SQLite.
- Paste an article, extract, cloze, and review with FSRS.
- Goal: prove the document model (marks, copies, read point).

**Phase 1: MVP that meets the minimum definition**

*Status (2026-11-04): everything below is built except the Anki .apkg export. Not yet tested by hand: the browser extension end to end, and image localization on a real article.*

- Browser extension import (Readability + images), URL import, and paste.
- Inbox triage, priority queue, auto-sort, auto-postpone, and Later today.
- Topic A-Factor scheduling, read points, Done!, delete-before-cursor, and ignore.
- Extract and cloze hierarchy, propagating references and images.
- FSRS items with grading, early review, and reschedule.
- Library tree, FTS search, and subset/branch review.
- Mercy and a postpone dialog with a simulate preview.
- Backup and export (SQLite file, plus Anki .apkg export for items).

**Phase 2: Power**

*Status (2026-11-04):*
- *Built:* PDF reader (text and region extracts, page read point, marks), EPUB, FSRS optimizer, per-priority retention, stats, folder and file import, split by headings.
- *Also built:* tree multi-select, context menus, drag-and-drop with manual order, items as parents, arrow-key navigation.
- *Not built:* image occlusion.

- PDF reader with region extracts, and EPUB.
- FSRS optimizer, per-priority retention, and a stats dashboard.
- Bulk folder import, splitting articles by headings, image occlusion.

**Phase 3: Everywhere**
- Sync: either an op-log/CRDT (e.g. cr-sqlite) or simple file sync with conflict detection.
- Tauri mobile app (reviewing and reading).
- YouTube and podcast transcripts, embeddings, and the optional AI assists.

## 8b. UI/UX brainstorm (round 2, after using Phase 1)

The ideas are grouped by where the friction is. ★ marks the ones I'd do next because they're cheap and get used every session.

### The core loop: read → extract → cloze → next
- ★ **Floating selection toolbar.** When text is selected, show Extract / Cloze / Q&A / Ignore next to the selection, with shortcut hints. The current top toolbar is far from where your eyes are.
- ★ **Automatic read point.** When you leave a topic without having set a read point, put one at the top visible paragraph. Show a progress sliver per article (read point ÷ length) and the estimated minutes left.
- **Cloze several keywords in a row.** After Alt+Z, keep the cursor in the sentence so the next selection plus Alt+Z makes the next cloze, without a toast for each one.
- **Extract preview.** On hover, a tooltip shows where an extracted span lives and when it's next due.
- **Focus mode.** Hide the sidebar and toolbars, centre the text, and slightly dim everything before the read point. One key toggles it.
- **Typography settings.** Font, size, line width, and a sepia theme. Long reading sessions live or die by this.

### Making priority usable
Priority is the concept people struggle with most.
- ★ **Triage by comparison.** In the Inbox, show the new article next to 3–5 existing ones that have known priorities ("more or less important than these?"). Dragging it among them sets its percentile.
- **Show priority as bands as well as numbers.** Critical, high, normal, low, someday. Colour the tree's badges by band.
- **Show the queue rank.** For example "#14 of 140 today": what the priority actually means for when you'll see it.

### Queue transparency and control
- ★ **"Why is this here?" chip.** Due date, days overdue, priority band, and whether it's from a subset review or was postponed.
- **Peek at what's next.** A drawer listing the next 10 elements. You can skip, defer, or reorder them by dragging.
- **Time-boxed sessions.** "I have 20 minutes" sets the order so the most important material comes first, then ends with a summary: read, extracted, created, graded.

### Writing good items
- ★ **Lint items while editing.** Gentle warnings about the minimum-information principle: question too long, several clozes in one item, an answer longer than about 5 words, a vague pronoun.
- **Leeches.** Items with 4 or more lapses get a flag and their own "reformulate" list in the sidebar's filters. FSRS will keep rescheduling them, but it can't rewrite them.
- **Context drawer on the answer side.** Collapsed by default, it shows the surrounding paragraph from the source, which helps when an item doesn't make sense out of context.
- **"Needs work" flag.** Marks an item to revisit when you have time. It keeps its normal schedule but shows a marker.

### Navigating and organising
- ★ **Command palette (Ctrl+K).** Every action, plus jump-to-element by title. This replaces memorising shortcuts.
- **Breadcrumb in the header.** Source › extract › extract, with each part clickable. It replaces the single "↑ parent" link.
- **Tree filters.** Due today, overdue, items only, leeches, PDFs, recently edited.
- **Pinned roots.** User topics like "Biology" stay at the top of the tree, separate from loose sources.
- ★ **Undo for destructive actions.** Done, Dismiss, Move, Delete and Postpone show an Undo button in the toast for about 8 seconds. This makes the context menu much less scary.

### Overload and wellbeing
- **Daily dashboard on the empty Learn screen.** Today's load, the forecast, priority protection, and "you're behind on top-priority material" warnings. No streaks or gamification.
- **Gentle overload banner.** When the queue is more than 2× your budget, offer Mercy or a postpone right there instead of hiding it in Tools.

### Mobile (phase 3, but design for it now)
- Review first: swipe to grade, tap to reveal.
- Reading with a long-press to extract.
- Triage the Inbox one-handed.
- Same keyboard-free action set as the desktop context menu.

*Status (2026-11-04):*
- **Built:** all ★ items, namely the selection toolbar, automatic read point with progress, triage by comparison, the "why" chip, item warnings, the Ctrl+K palette, and Undo (toast and Ctrl+Z).
- **Priority** now works like SuperMemo's: the % is a position in one global queue.
- **The editor** is live Markdown (Typora-style) with MathJax math.

## 9. Decisions (2026-11-04)

1. **Mobile is a goal**, so we use Tauri 2 from the start.
2. **PDF waits for phase 2.** The MVP covers HTML, web pages and pasted text.
3. **The core is in Rust from day one** (rusqlite + the `fsrs` crate).
4. **Personal tool** with a single user. Onboarding, multi-user features and polish for import edge cases are not priorities.
5. **AI features come later** (phase 3 at the earliest).
