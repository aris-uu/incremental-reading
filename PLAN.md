# Modern Incremental Reading — Brainstorm & Plan

Status: phases 0–2 and the round-2 UI list are built (2026-11-05); phase 3 has started with incremental video. See the status notes under each phase.

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

*Status (2026-11-05): everything below is built, including the Anki .apkg export (Tools → Backup & export, or right-click a branch). Not yet tested by hand: the browser extension end to end, image localization on a real article, and importing an export into Anki itself.*

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
- *Also built (2026-11-05):* image occlusion. Select an image in a topic and press Occlude (Alt+O), or use "New image occlusion from a file…" in the palette; drag to cover regions, which gives one hide-all/guess-one item per region.

- PDF reader with region extracts, and EPUB.
- FSRS optimizer, per-priority retention, and a stats dashboard.
- Bulk folder import, splitting articles by headings, image occlusion.

**Phase 3: Everywhere**

*Status (2026-11-05):*
- *Built:* **incremental video (YouTube).** Paste a YouTube link in the import window, or send it from the browser extension.
  - The topic shows the player and saves a resume position, the video equivalent of a read point.
  - Marking a start and an end (Alt+B / Alt+E) makes a **clip extract**, a child topic that plays just that range and carries the matching transcript paragraphs.
  - The transcript becomes the topic's text, so extract and cloze work as usual, and its `[m:ss]` timestamps seek the player. Fetching transcripts is best effort because YouTube increasingly guards its caption endpoint; when it fails, paste the text from "Show transcript" and click "Link pasted transcript".
- *Not built:* sync, the mobile app, podcasts, embeddings, AI assists.

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
- **Also built (2026-11-05):** the rest of the list.
  - In the reader: consecutive clozes (one counter instead of a toast each), a hover preview of extracts and clozes, focus mode (Ctrl+Shift+F) that dims text before the read point, and a theme setting (light, sepia, dark).
  - Priority and the queue: priority bands on badges and in the "why" chip, the "Up next" drawer (skip, defer, reorder), time-boxed sessions with an end-of-session summary, a daily dashboard on the empty Learn screen, and an overload banner offering Mercy or Postpone.
  - Items: leech flags, a "needs work" flag (Alt+W), and a context drawer on the answer side.
  - Organising: breadcrumbs, tree filters (due, overdue, items, leeches, needs work, PDFs, videos, recently edited), and pinned roots.

## 8c. UI/UX and workflow brainstorm (round 3)

*Built (2026-11-05):*
- **Space as the default action:** show answer → Good; Next for topics. Esc leaves the text, so Space works again.
- **The element browser** (Ctrl+Shift+B), described below.
- **A-Factor controls:** − / + nudges and an exact value on every topic, and bulk changes in the browser.

### The element browser (built)
One table of every element, in the main window, with a live preview and editor on the right. It replaces several one-off screens:
- **Search language** in the Anki style:
  - `is:due`, `is:overdue`, `is:leech`, `is:new`, `is:needs-work`, `is:video`, `is:pdf`, `is:cloze`, …
  - `under:12` (a branch), `child:12`, `id:3,4`
  - comparisons: `prio<20`, `due<=0`, `ivl>30`, `lapses>=4`, `af>2`, `added<7`, `edited<7`, `chars>5000`
  - `title:word`, `-negation`, `a or b`; bare words search the full text.
- **Presets:** priority queue, due today, overdue, leeches, needs work, new items, unread topics, videos and PDFs, added this week, inbox, done.
- **Sorting:** every column sorts. The default `#` column is the priority queue order.
- **Selection:**
  - Selecting works like in a file manager: click, Ctrl+click, Shift+click, arrow keys, Ctrl+A.
  - Shortcuts: <kbd>D</kbd> descendants, <kbd>R</kbd> review the selection (or every result) as a session, <kbd>P</kbd> priority, <kbd>A</kbd> A-Factor, <kbd>M</kbd> move, <kbd>Enter</kbd> open in the reader.
  - The right-click menu also has parent, siblings, review branch, dismiss, done, restore, delete, needs work, and Anki export.
- Right-click a branch in the tree and choose "Show descendants in the browser".

### Next ideas for the browser
- ★ **Saved searches** that you name and pin as chips, with counts. For example "Exam: cardio" = `under:120 is:item`.
- ★ **Column chooser:** stability, retrievability today, created date, source, size, and the path in the tree.
- **Inline edits:** type a priority or due date straight into the cell. Typing the priority uses the same queue placement as the header.
- **Ranges by dragging the # column:** drag rows to reorder the priority queue by hand. That is SuperMemo's "priority queue" window, done well.
- **Group by root or source** with collapsible groups and a subtotal per group (due, leeches).
- **Find duplicates:** items whose question text is very similar, or extracts of the same passage.
- **"Retrievability today" column and filter** (`r<0.8`): what is about to be forgotten.

### Reading workflow
- ★ **Read-point resume list:** "Continue reading" on the empty Learn screen. It lists started topics sorted by progress or priority, so a long article can be finished deliberately instead of waiting for its next interval.
- ★ **Process-to-the-end mode:** a topic stays open after Next, and Space moves to the next paragraph after the read point. You decide topic by topic, but a session can be "finish this article" without going back to the queue.
- **Extract with priority:** Shift+Alt+X asks for (or offsets) the new extract's priority, so important passages jump ahead of their parent.
- **Extract into a new topic elsewhere**, for example "extract into: Cardiology", so the knowledge tree grows by subject rather than by source.
- **Mark the read point automatically when scrolling past paragraphs that were all extracted or ignored.**
- **Table of contents** (from the headings) in a narrow side gutter, with extract density shown per section.
- **Video:** playback speed (1.25–2×) remembered per video, A–B repeat for a clip, a timestamp in the text for each clip extract, and keyboard frame-step for diagrams.

### Item workflow
- ★ **Edit while reviewing without breaking flow:** Ctrl+E focuses the question and Esc returns to grading. Saving is already automatic.
- **Reverse card** for Q&A ("also ask answer → question"), created as a second item.
- **Cloze siblings:** several clozes from one sentence spread out automatically, so they don't come up on the same day.
- **Type-in answers** for short facts (spelling, numbers), with a diff shown on reveal.
- **Image occlusion upgrades:** polygon or ellipse regions, a "hide one, show the others" mode, and grouping several regions into one item.

### Navigation and organisation
- **Back and forward** (Alt+←/→) through opened elements, like a browser.
- **Recent elements** in the palette (Ctrl+K with no query).
- **Hoisting:** focus the tree on one branch so its root becomes the top level, plus a breadcrumb to un-hoist.
- **Tags and concepts:** the cross-cutting grouping from §6 that is still missing. Usable from the browser (`tag:physio`) and for subset review.
- **Split view:** the source and its extract side by side, for rewriting an extract to stand on its own.

### Feedback and calm
- **Session goals:** "today: finish 2 articles, 150 reviews" with a quiet progress ring. No streak counter.
- **End-of-day review:** what you extracted today, as a list to skim for anything you'd like to change.
- **Undo history panel:** the last 30 journaled actions, each undoable on its own, not just the most recent.

### Status of round 3 (2026-11-05)
**Built:**
- **Browser:**
  - saved searches stored as chips in the collection;
  - a column chooser (right-click the header) with R, stability, tags, size and date added;
  - double-click to type a priority;
  - drag rows to reorder the priority queue when sorted by #;
  - `is:duplicate`, `tag:x`, `r<0.85`, and the "About to be forgotten" and "Made today" presets.
- **Reading:**
  - Shift+Alt+X extracts with a chosen priority;
  - an extract counter ("12 from this topic — be selective");
  - a Contents menu;
  - video speed remembered per video (Alt+.), with Alt+J/L to skip 10 s.
- **Items:**
  - Ctrl+E edits the question during review;
  - reverse cards for Q&A;
  - one per day per parent, so siblings are spaced apart in the daily queue;
  - leech actions (Reformulate / Split / Retire);
  - "Split list" for list answers;
  - pass/fail grading as an option.
- **Navigation:** back/forward (Alt+←/→), recent elements in Ctrl+K, focusing the tree on a branch, and tags with an editor in the header.
- **Calm:** an undo-history dialog; "Continue reading" and "Still important?" (priority audit) on the empty Learn screen.
- **Tools:**
  - "Before a break" brings upcoming work forward;
  - an exam mode with higher retention for one branch until a date;
  - a SuperMemo key preset (Enter as Space, Alt+P priority).

**Not built yet:**
- browser: grouping by root
- process-to-the-end mode
- extracting into a topic elsewhere
- an automatic read point past processed paragraphs
- video frame-step
- type-in answers
- occlusion polygons and grouping
- split view
- session goals

## 8d. Learning effectiveness and efficiency

The aim is more retained knowledge per minute, not more reviews. Each idea below says what it improves and how we would check it.

### Measure first
- ★ **Per-element cost:** record time on card (the item grade log already exists; add `duration_ms`) and time on each topic read. Then the stats can show **cost per item per year** and **leeches by time spent**. That is the honest metric: a leech is whatever eats time, not just whatever has lapses.
- ★ **Retention calibration:** compare predicted recall with actual results by priority band and by source, so you can see whether "critical" material really sits at 0.95.
- **Source yield:** for each source, items created × retention ÷ minutes spent. This tells you which sources were worth importing, which should change triage.

### Better items, fewer reviews
- ★ **Stability-aware leech handling:** after the 4th lapse, offer **reformulate** (opens the editor with the lint hints), **split**, **add a mnemonic or image**, or **retire** (dismiss, keep the extract). Logging which choice was made shows over time what actually works.
- **Interference detection:** items that are often forgotten together, or that have similar text, get flagged as "confusable". Suggest a contrastive item ("A vs B: what's the difference?").
- **Answer-length budget:** lint already warns. Add a "simplify" action that splits a list answer into one cloze per entry.
- **Context-free check:** before an item is created, show its question without its parent. If it doesn't make sense alone, it needs context. That is SuperMemo's "minimum information" rule made concrete.

### Scheduling
- ★ **FSRS per-item retrievability in the queue:** order items by how much each review is worth (expected stability gain per second) instead of only by priority, within the daily budget. Reviews that are almost certainly remembered move later automatically.
- **Desired retention from priority** is already built. Add **"cram" retention** for a branch before a date (an exam): raise the target only for that branch until the date, then go back to normal.
- **Topic A-Factor learning:** when you repeatedly press "Later today" or "Don't get it" on a topic, or postpone it, nudge its A-Factor up; when you extract a lot from it, nudge it down. SuperMemo does this by hand; we can suggest it with one click to accept.
- **Load smoothing:** spread new extracts and items so next week's forecast stays flat. Today's Mercy fixes a backlog after the fact; smoothing prevents one.
- **Sibling spacing:** an item's siblings (same parent) don't come up on the same day, which avoids getting the answer for free from a neighbour.

### Reading efficiency
- **Triage faster:** in the Inbox, show the estimated reading time and a short preview, so you can decide "skim" or "keep" quickly.
- **Skim-first topics:** a topic's first read shows the headings and first sentences only. Pressing a key expands the section you want, and unread sections stay as children to read later.
- **Extract budget per source:** a gentle counter ("12 extracts from this article") that nudges toward selectivity. Over-extracting is the most common way to build a backlog.
- **Spaced reading of finished extracts:** when an extract has given its items, offer Done! (its job is done) instead of letting it come back forever.

### Generation and transfer (deeper learning)
- **Elaboration prompts** on some items, the "why?" and "how does this connect to…?" cards that the minimum-information principle tends to crowd out. Graded like normal items, but rare.
- **Concept maps from the tree:** a branch view showing extracts and items as nodes. Seeing gaps helps decide what to read next.
- **Interleaving by subject:** within the item budget, mix branches rather than doing all of one source in a row. This is better for discrimination, and the queue already interleaves topics.
- **Retrieval before reading:** for a topic marked "important", show the titles of its existing items before the text, so you try to recall first, then read.

### Priority hygiene
- ★ **Priority audit:** a weekly prompt lists the 10 most important topics you haven't touched in a long time, with "still important?" buttons (keep, lower, dismiss). It stops the head of the queue from filling with good intentions.
- **Priority drift by age:** let unopened low-value material slowly sink, with an undoable log of what moved.


### Status (2026-11-05)
**Built:**
- **Measurement:** time per review and per read, cost per item, retention calibration by priority band, the items that cost the most time, and minutes and items per hour per source (all in Stats).
- **Leech actions.**
- **Exam mode.**
- **Smoothing new material:** new extracts and items go to the least loaded of the next 3 days when tomorrow is over budget.
- **Sibling spacing.**
- **Priority audit.**
- **Extract counter**, and a "Done! once it has nothing more to give" hint on extracts that have produced items.
- **A-Factor nudge:** "Don't get it" adds 0.2.

**Not built yet:**
- ordering items by the value of each review
- spotting confusable pairs
- skim-first topics
- elaboration prompts
- concept maps
- interleaving by subject
- recalling before reading
- priority drift
- automatic A-Factor learning beyond the "Don't get it" nudge

## 9. Decisions (2026-11-04)

1. **Mobile is a goal**, so we use Tauri 2 from the start.
2. **PDF waits for phase 2.** The MVP covers HTML, web pages and pasted text.
3. **The core is in Rust from day one** (rusqlite + the `fsrs` crate).
4. **Personal tool** with a single user. Onboarding, multi-user features and polish for import edge cases are not priorities.
5. **AI features come later** (phase 3 at the earliest).

## 10. Japanese: sentence mining

**Current setup:** VN → texthooker → Yomitan → Anki (Senren note type).
**Goal:** keep Yomitan and its dictionaries, but mine into this collection, where cards sit next to the text they came from and share one priority queue with the reading.

### Built (2026-11-05)
- **Sentence items** (`item_type = sentence`). They store Senren's fields: `word`, `reading`, `sentence`, `sentenceFurigana`, `sentenceTranslation`, `definition`, `glossary`, `wordAudio`, `sentenceAudio`, `picture`, `pitchAccents`, `frequencies`, `freqSort`, `miscInfo`, …
  - **Front:** the sentence with the target word highlighted (`<b>` or `span.highlight`, like Senren).
  - **Back:** the word with furigana, audio buttons, pitch accent, frequencies, the gloss (Senren's order: selection text, then definition, then glossary), picture, translation, notes and source.
  - Card type follows Senren's `sentenceCard` / `audioCard` flags. The default is set in Tools → Japanese & Yomitan and is "sentence".
  - Audio plays automatically. Dictionary HTML is sanitised (no scripts, embeds or event handlers).
- **Yomitan → app (AnkiConnect-compatible server)**, on 127.0.0.1:8766 by default:
  - Point Yomitan's AnkiConnect address at the app and choose the **Senren** note type. Senren's recommended field markers work unchanged.
  - Supported actions: `version`, `deckNames`, `modelNames`, `modelFieldNames`, `findNotes` (`deck:`, `word:`, wildcards, `added:N`), `canAddNotes` (duplicate check on `word`), `addNote(s)`, `storeMediaFile`, `notesInfo`, `updateNoteFields`, `guiBrowse`, `guiEditNote`, `multi`, …
  - Decks become topics (`Japanese::Mining` → nested topics). mpvacious and ShareX scripts can attach screenshots and audio to the last card through `updateNoteFields`.
  - Requests from websites are refused; browser extensions and local tools are allowed. An optional API key is supported.
- **App → Yomitan** (reading an EPUB or article inside the app, where extensions can't run): through the **Yomitan API** (`yomitan-api`, `POST /ankiFields`).
  - Select a word, then press **Alt+D** to look it up in a popup, or **Alt+S** to make a sentence card.
  - Alt+S finds the sentence around the selection (。！？ and 「」 aware) and highlights the target, which can be widened or narrowed by a character. Yomitan fills in the dictionary form, reading, glossary, audio, pitch and frequency.
  - The card goes under the article it came from, and the word gets a link mark back to the card. Alternatively it can go into a fixed deck.
- **Frequency-ordered learning:** `freqSort` (Yomitan's harmonic frequency rank) sets the card's place in the priority queue, so common words come first. Senren's "sort new cards by frequency" happens automatically.

### Built (round 2)
- **Hover dictionary:**
  - Hold Shift over a word (or just rest the mouse, per the setting) in the reader or the texthooker. The text from the cursor goes to the Yomitan API (`/ankiFields` with `cloze-body`), which finds the longest match; that word is highlighted in the text.
  - The popup shows up to 3 entries with reading, pitch, frequency and gloss.
  - **＋** makes a sentence card from the sentence under the cursor, with the audio stored. In the reader, the word gets a link mark back to the card.
- **Texthooker** (top bar → Hooker):
  - The app connects as a client to the hook's WebSocket (`ws://localhost:6677` by default, the same one texthooker UIs use with Textractor's WebSocket extension, LunaTranslator or agent). JSON messages (`{sentence}`, `{text}`) are understood as well as plain text.
  - Lines are shown big, de-duplicated and auto-scrolled, and each one is **written into a topic** "VN › Route" (created on the fly, nesting with `::`). A timestamped heading marks each session.
  - Reading stats: characters, active time (pauses after 2 minutes idle) and characters per hour.
  - Pause, hide a line, paste lines by hand.
  - Hover lookup and Alt+S sentence cards work on the lines.
  - It keeps running while you use the rest of the app, and the session topic becomes an ordinary article to reread, extract and mine from later.

### Workflow
1. **Sources:**
   - **EPUB:** import it (chapters become topics), read incrementally with a read point, and mine with Alt+S. Yomitan's own popup isn't available inside the app; Alt+D takes its place.
   - **VN or browser reading** (texthooker page, ttu-reader, web): keep Yomitan as it is and change only the AnkiConnect address. Cards land in the "Japanese::Mining" topic, or whichever deck you choose in Yomitan.
   - **YouTube with Japanese subtitles:** the transcript becomes a video topic; mine sentences from it, and a clip extract keeps the audio context.
   - **Anime:** mpvacious → AnkiConnect → the app.
2. **Triage:** whole books go to the Inbox; mined cards go straight to the queue (no point in triaging a word you just looked up).
3. **Review:** Space reveals, Space again means Good, with pass/fail grading as an option. Leech tools, "needs work" and Edit fields apply as for other items. The parent article stays one click away (breadcrumb, and the context drawer on the back).
4. **Reading load:** use A-Factor and priority to keep a few books "active" and the rest slow. Use "Continue reading" to finish a chapter.

### Ideas (not built)
- **Known-word tracking:** mark words as known (from mature cards and a frequency list) and colour unknown words in the reader. Then i+1 sentence search: find sentences in your library with exactly one unknown word, and offer them as cards.
- **In-reader Yomitan-style popup on hover,** using `/termEntries` and `/tokenize` from yomitan-api. Shift+hover would show a definition without selecting.
- **Furigana toggle** for the reader (from `/tokenize` readings), and per-word furigana in `sentenceFurigana` when mining in the app.
- **Sentence audio from the source:** for video topics, cut the clip's audio into `sentenceAudio`. For EPUBs, use TTS (optional).
- **Picture from the source:** for video topics, a frame at the clip start goes into `picture`.
- **Mining statistics:** words mined per book, retention by frequency band, and a coverage estimate per book (the share of tokens you know).
- **Export to Anki as Senren notes,** with fields intact, instead of Basic.
- **Kanji cards** through Yomitan's kanji markers (`type: kanji`).
