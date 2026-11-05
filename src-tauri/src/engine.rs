//! Incremental-reading core: elements, topic scheduling (A-Factor), item
//! scheduling (FSRS), the daily queue, overload tools and search.
//! Independent of Tauri so it can be unit-tested.

use fsrs::{MemoryState, FSRS};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type Result<T> = std::result::Result<T, String>;

fn e<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

/// Items shown per topic when interleaving the queue (SuperMemo suggests 3–8).
pub const ITEMS_PER_TOPIC: usize = 4;
pub const EMPTY_DOC: &str = r#"{"type":"doc","content":[{"type":"paragraph"}]}"#;

pub fn now_ts() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Learning day number. The day rolls over at 04:00 local time.
pub fn today() -> i64 {
    let shifted = chrono::Local::now() - chrono::Duration::hours(4);
    let epoch = chrono::NaiveDate::from_ymd_opt(1970, 1, 1).unwrap();
    (shifted.date_naive() - epoch).num_days()
}

// ---------- Settings ----------

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(default)]
pub struct Settings {
    /// Item reviews per day before auto-postpone kicks in.
    pub item_budget: i64,
    /// Topics per day before auto-postpone kicks in.
    pub topic_budget: i64,
    /// Elements with priority below this (more important) are never auto-postponed.
    pub protect_priority: f64,
    /// FSRS desired retention for the most important items (priority 0%)...
    pub retention_top: f64,
    /// ...and for the least important (100%). Linear in between.
    pub retention_bottom: f64,
    /// Auto-postpone delays an item only while its predicted recall stays above this.
    pub retention_floor: f64,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { item_budget: 150, topic_budget: 30, protect_priority: 10.0, retention_top: 0.93, retention_bottom: 0.85, retention_floor: 0.75 }
    }
}

impl Settings {
    /// Desired retention for an item of this priority: important material is
    /// kept at higher recall (and reviewed more often).
    pub fn retention_for(&self, priority: f64) -> f64 {
        let t = (priority.clamp(0.0, 100.0)) / 100.0;
        self.retention_top + (self.retention_bottom - self.retention_top) * t
    }
}

fn setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    conn.query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get(0)).optional().map_err(e)
}

fn put_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(e)?;
    Ok(())
}

pub fn get_settings(conn: &Connection) -> Result<Settings> {
    Ok(setting(conn, "settings")?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default())
}

pub fn set_settings(conn: &Connection, s: &Settings) -> Result<()> {
    let mut s = s.clone();
    s.retention_top = s.retention_top.clamp(0.7, 0.99);
    s.retention_bottom = s.retention_bottom.clamp(0.7, 0.99);
    s.retention_floor = s.retention_floor.clamp(0.3, s.retention_bottom.min(s.retention_top));
    s.item_budget = s.item_budget.max(1);
    s.topic_budget = s.topic_budget.max(1);
    put_setting(conn, "settings", &serde_json::to_string(&s).map_err(e)?)
}

/// UI state that belongs to the collection (saved searches…), under `ui.<key>`.
pub fn get_ui_state(conn: &Connection, key: &str) -> Result<Option<String>> {
    setting(conn, &format!("ui.{key}"))
}

pub fn set_ui_state(conn: &Connection, key: &str, value: &str) -> Result<()> {
    put_setting(conn, &format!("ui.{key}"), value)
}

/// Random secret the browser extension must send. Created on first use.
pub fn extension_token(conn: &Connection) -> Result<String> {
    if let Some(t) = setting(conn, "ext_token")? {
        return Ok(t);
    }
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf).map_err(e)?;
    let token: String = buf.iter().map(|b| format!("{b:02x}")).collect();
    put_setting(conn, "ext_token", &token)?;
    Ok(token)
}

// ---------- DTOs ----------

#[derive(Serialize, Debug, Clone)]
pub struct QueueEntry {
    pub id: i64,
    pub kind: String,
    pub title: String,
    pub priority: f64,
    pub due_day: i64,
}

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct PostponeReport {
    pub items: i64,
    pub topics: i64,
}

#[derive(Serialize, Debug)]
pub struct QueueResult {
    pub entries: Vec<QueueEntry>,
    /// Set when today's auto-postpone ran while building this queue.
    pub auto_postponed: Option<PostponeReport>,
}

#[derive(Serialize, Debug)]
pub struct Reference {
    pub source_id: i64,
    pub title: String,
    pub url: Option<String>,
    pub author: Option<String>,
    pub site: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct TopicData {
    pub doc_json: String,
    pub read_point: Option<i64>,
    pub afactor: f64,
    pub interval_days: i64,
    pub due_day: i64,
    pub last_day: Option<i64>,
    /// Text removed by Done! that Restore can bring back.
    pub archived: bool,
    /// PDF topics: file name in assets and the page to resume at.
    pub pdf_asset: Option<String>,
    pub pdf_page: Option<i64>,
    pub text_len: i64,
    /// Video topics: YouTube id, clip range for clip extracts, resume position (seconds).
    pub video_id: Option<String>,
    pub video_start: Option<f64>,
    pub video_end: Option<f64>,
    pub video_pos: Option<f64>,
}

#[derive(Serialize, Debug)]
pub struct ItemData {
    pub item_type: String,
    /// ProseMirror documents.
    pub question: String,
    pub answer: String,
    pub stability: Option<f64>,
    pub difficulty: Option<f64>,
    pub interval_days: i64,
    pub due_day: i64,
    pub last_day: Option<i64>,
    pub reps: i64,
    pub lapses: i64,
    /// Sentence items: their fields (JSON object).
    pub fields_json: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct ElementFull {
    pub id: i64,
    pub kind: String,
    pub parent_id: Option<i64>,
    pub parent_title: Option<String>,
    pub title: String,
    pub priority: f64,
    pub status: String,
    pub children: i64,
    pub topic: Option<TopicData>,
    pub item: Option<ItemData>,
    pub reference: Option<Reference>,
    /// Position in the priority queue (1 = most important) and queue length.
    pub queue_rank: i64,
    pub queue_size: i64,
    /// Why it might be in today's queue: the last scheduling event.
    pub last_event: Option<String>,
    /// Path from the top-level root down to the parent (breadcrumb).
    pub ancestors: Vec<Crumb>,
    pub pinned: bool,
    pub needs_work: bool,
    pub tags: Vec<String>,
}

#[derive(Serialize, Debug)]
pub struct Crumb {
    pub id: i64,
    pub title: String,
}

#[derive(Serialize, Debug)]
pub struct TreeNode {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub kind: String,
    pub title: String,
    pub priority: f64,
    pub status: String,
    pub due_day: Option<i64>,
    /// A topic with no text (a note root or folder, or a finished article).
    pub empty: bool,
    pub pdf: bool,
    pub video: bool,
    /// Manual order among siblings.
    pub position: f64,
    /// Items only: times forgotten (the UI flags 4 or more as a leech).
    pub lapses: i64,
    pub pinned: bool,
    pub needs_work: bool,
    pub updated_at: i64,
}

#[derive(Deserialize, Debug, Default)]
pub struct ImportInput {
    pub title: String,
    pub doc_json: String,
    pub priority: f64,
    pub url: Option<String>,
    pub author: Option<String>,
    pub site: Option<String>,
    /// Land in the inbox for triage instead of going straight to the queue.
    #[serde(default)]
    pub inbox: bool,
    /// Import under an existing topic (folder imports, EPUB chapters).
    #[serde(default)]
    pub parent: Option<i64>,
    /// YouTube video id: an incremental-video topic (`doc_json` holds the transcript, if any).
    #[serde(default)]
    pub video_id: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct InboxEntry {
    pub id: i64,
    pub title: String,
    pub priority: f64,
    pub url: Option<String>,
    pub site: Option<String>,
    pub chars: i64,
    pub created_at: i64,
}

#[derive(Serialize, Debug)]
pub struct Stats {
    pub today: i64,
    pub due_topics: i64,
    pub due_items: i64,
    pub inbox: i64,
    pub total_topics: i64,
    pub total_items: i64,
}

// ---------- Text helpers ----------

/// Plain text of a ProseMirror JSON document (for titles and search).
pub fn doc_text(doc_json: &str) -> String {
    fn walk(v: &Value, out: &mut String) {
        if matches!(v.get("type").and_then(Value::as_str), Some("htmlBlock") | Some("htmlInline")) {
            if let Some(h) = v.pointer("/attrs/html").and_then(Value::as_str) {
                out.push_str(&crate::sentence::html_to_text(h).replace('\n', " "));
                out.push(' ');
            }
            return;
        }
        if v.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(t) = v.get("text").and_then(Value::as_str) {
                out.push_str(t);
            }
            return;
        }
        if let Some(children) = v.get("content").and_then(Value::as_array) {
            for c in children {
                walk(c, out);
            }
            if !out.ends_with(['\n', ' ']) && !out.is_empty() {
                out.push('\n');
            }
        }
    }
    let mut out = String::new();
    if let Ok(v) = serde_json::from_str::<Value>(doc_json) {
        walk(&v, &mut out);
    }
    out.trim().to_string()
}

fn short_title(text: &str) -> String {
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut t: String = one_line.chars().take(80).collect();
    if one_line.chars().count() > 80 {
        t.push('…');
    }
    if t.is_empty() {
        "Untitled".into()
    } else {
        t
    }
}

// ---------- Elements ----------

/// Where a new element enters the priority queue.
#[derive(Clone, Copy, Debug)]
pub enum Place {
    /// At this percentile of the active queue.
    Percent(f64),
    /// Right after this element (extracts and items follow their parent).
    After(i64),
}

fn insert_element(conn: &Connection, kind: &str, parent: Option<i64>, title: &str, place: Place, status: &str) -> Result<i64> {
    let ts = now_ts();
    let requested = match place {
        Place::Percent(p) => p.clamp(0.0, 100.0),
        Place::After(other) => priority_of(conn, other)?,
    };
    conn.execute(
        "INSERT INTO element (kind, parent_id, title, priority, status, created_at, updated_at, position, prank)
         VALUES (?1,?2,?3,?4,?5,?6,?6, (SELECT COALESCE(MAX(position), 0) + 1 FROM element), (SELECT COALESCE(MAX(prank), 0) + 1 FROM element))",
        params![kind, parent, title, requested, status, ts],
    )
    .map_err(e)?;
    let id = conn.last_insert_rowid();
    // Inbox material isn't in the queue yet; it keeps the requested priority until accepted.
    if status != "inbox" {
        match place {
            Place::Percent(p) => place_at_percent(conn, id, p)?,
            Place::After(other) => place_after(conn, id, other)?,
        }
        recompute_priorities(conn)?;
    }
    Ok(id)
}

// ---------- Priority queue ----------

/// Renumber queue positions 1..N (keeping order) and refresh every active
/// element's percentile: 0% is the head of the queue, 100% the tail.
pub fn recompute_priorities(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "WITH o AS (SELECT id, ROW_NUMBER() OVER (ORDER BY prank, id) AS r FROM element)
         UPDATE element SET prank = o.r FROM o WHERE o.id = element.id AND element.prank != o.r;
         WITH a AS (SELECT id, ROW_NUMBER() OVER (ORDER BY prank, id) - 1 AS i, COUNT(*) OVER () AS n FROM element WHERE status = 'active')
         UPDATE element SET priority = CASE WHEN a.n <= 1 THEN 0 ELSE ROUND(a.i * 100.0 / (a.n - 1), 4) END
         FROM a WHERE a.id = element.id;",
    )
    .map_err(e)
}

/// Give `id` a queue position at percentile `p` of the other active elements.
fn place_at_percent(conn: &Connection, id: i64, p: f64) -> Result<()> {
    let ranks: Vec<f64> = conn
        .prepare("SELECT prank FROM element WHERE status = 'active' AND id != ?1 ORDER BY prank, id")
        .map_err(e)?
        .query_map([id], |r| r.get(0))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    let n = ranks.len();
    let idx = ((p.clamp(0.0, 100.0) / 100.0) * n as f64).round() as usize;
    let rank = match (idx, n) {
        (_, 0) => 1.0,
        (0, _) => ranks[0] - 1.0,
        (i, n) if i >= n => ranks[n - 1] + 1.0,
        (i, _) => (ranks[i - 1] + ranks[i]) / 2.0,
    };
    conn.execute("UPDATE element SET prank=?2 WHERE id=?1", params![id, rank]).map_err(e)?;
    Ok(())
}

/// Put `id` immediately after `other` in the queue.
fn place_after(conn: &Connection, id: i64, other: i64) -> Result<()> {
    let base: f64 = conn.query_row("SELECT prank FROM element WHERE id=?1", [other], |r| r.get(0)).map_err(e)?;
    let next: Option<f64> = conn
        .query_row("SELECT MIN(prank) FROM element WHERE prank > ?1 AND id != ?2", params![base, id], |r| r.get(0))
        .map_err(e)?;
    let rank = next.map_or(base + 1.0, |n| (base + n) / 2.0);
    conn.execute("UPDATE element SET prank=?2 WHERE id=?1", params![id, rank]).map_err(e)?;
    Ok(())
}

/// Several elements to percentile `p`, kept together in their given order.
pub fn set_priority_many(conn: &Connection, ids: &[i64], p: f64) -> Result<()> {
    let Some((&first, rest)) = ids.split_first() else { return Ok(()) };
    place_at_percent(conn, first, p)?;
    let mut prev = first;
    for &id in rest {
        place_after(conn, id, prev)?;
        prev = id;
    }
    recompute_priorities(conn)?;
    for &id in ids {
        touch(conn, id)?;
    }
    Ok(())
}

/// Position in today's terms: 1-based rank among active elements, and their count.
pub fn queue_rank(conn: &Connection, id: i64) -> Result<(i64, i64)> {
    conn.query_row(
        "SELECT (SELECT COUNT(*) FROM element a WHERE a.status='active' AND (a.prank < e.prank OR (a.prank = e.prank AND a.id < e.id))) + 1,
                (SELECT COUNT(*) FROM element WHERE status='active')
         FROM element e WHERE e.id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .map_err(e)
}

#[derive(Serialize, Debug)]
pub struct Anchor {
    pub id: i64,
    pub title: String,
    pub priority: f64,
}

/// Reference elements at a few percentiles, for triage by comparison.
pub fn priority_anchors(conn: &Connection) -> Result<Vec<Anchor>> {
    let mut out: Vec<Anchor> = Vec::new();
    for p in [5.0, 20.0, 40.0, 60.0, 80.0, 95.0] {
        let a = conn
            .query_row(
                "SELECT id, title, priority FROM element WHERE status='active' AND kind='topic' ORDER BY ABS(priority - ?1), prank LIMIT 1",
                [p],
                |r| Ok(Anchor { id: r.get(0)?, title: r.get(1)?, priority: r.get(2)? }),
            )
            .optional()
            .map_err(e)?;
        if let Some(a) = a {
            if !out.iter().any(|x| x.id == a.id) {
                out.push(a);
            }
        }
    }
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
fn log(conn: &Connection, id: i64, day: i64, kind: &str, grade: Option<i64>, elapsed: Option<i64>, interval: Option<i64>, s: Option<f64>, d: Option<f64>) -> Result<()> {
    conn.execute(
        "INSERT INTO review_log (element_id, ts, day, kind, grade, elapsed_days, interval_after, stability, difficulty) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![id, now_ts(), day, kind, grade, elapsed, interval, s, d],
    )
    .map_err(e)?;
    Ok(())
}

fn simple_log(conn: &Connection, id: i64, day: i64, kind: &str, interval: Option<i64>) -> Result<()> {
    log(conn, id, day, kind, None, None, interval, None, None)
}

/// Refresh the full-text index for one element.
pub fn index(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM search WHERE element_id=?1", [id]).map_err(e)?;
    let row: Option<(String, Option<String>, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT e.title, t.doc_json, i.question, i.answer FROM element e
             LEFT JOIN topic t ON t.element_id=e.id LEFT JOIN item i ON i.element_id=e.id WHERE e.id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(e)?;
    let Some((title, doc, q, a)) = row else { return Ok(()) };
    let body = match (doc, q, a) {
        (Some(d), _, _) => {
            let text = doc_text(&d);
            // A PDF or video topic has its content in the file, not (only) the document.
            conn.execute(
                "UPDATE topic SET text_len = CASE WHEN pdf_asset IS NOT NULL OR video_id IS NOT NULL THEN MAX(?2, 1) ELSE ?2 END WHERE element_id=?1",
                params![id, text.chars().count() as i64],
            )
            .map_err(e)?;
            text
        }
        (None, Some(q), Some(a)) => format!("{}\n{}", doc_text(&q), doc_text(&a)),
        _ => String::new(),
    };
    conn.execute("INSERT INTO search (element_id, title, body) VALUES (?1,?2,?3)", params![id, title, body]).map_err(e)?;
    Ok(())
}

pub fn reindex_all(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM search", []).map_err(e)?;
    let ids: Vec<i64> = conn
        .prepare("SELECT id FROM element")
        .map_err(e)?
        .query_map([], |r| r.get(0))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    for id in ids {
        index(conn, id)?;
    }
    Ok(())
}

/// Starting A-Factor for a topic. Long texts grow intervals faster (they are
/// read in many small portions anyway); important texts come back sooner.
pub fn initial_afactor(text_len: usize, priority: f64) -> f64 {
    let length_part = if text_len < 500 { 1.3 } else if text_len < 5000 { 1.5 } else { 1.8 };
    let priority_part = (priority.clamp(0.0, 100.0) / 100.0) * 0.4; // 0..0.4
    ((length_part + priority_part) * 100.0).round() / 100.0
}

pub fn import_topic(conn: &Connection, input: &ImportInput, day: i64) -> Result<i64> {
    let status = if input.inbox { "inbox" } else { "active" };
    let title = if input.title.trim().is_empty() { short_title(&doc_text(&input.doc_json)) } else { input.title.trim().to_string() };
    let id = insert_element(conn, "topic", input.parent, &title, Place::Percent(input.priority), status)?;
    let text_len = doc_text(&input.doc_json).len();
    conn.execute(
        "INSERT INTO topic (element_id, doc_json, afactor, interval_days, due_day, video_id) VALUES (?1,?2,?3,0,?4,?5)",
        params![id, input.doc_json, initial_afactor(text_len.max(if input.video_id.is_some() { 5000 } else { 0 }), input.priority), day, input.video_id],
    )
    .map_err(e)?;
    conn.execute(
        "INSERT INTO source_ref (element_id, url, author, site, accessed_at) VALUES (?1,?2,?3,?4,?5)",
        params![id, input.url, input.author, input.site, now_ts()],
    )
    .map_err(e)?;
    simple_log(conn, id, day, "create", Some(0))?;
    index(conn, id)?;
    Ok(id)
}

fn priority_of(conn: &Connection, id: i64) -> Result<f64> {
    conn.query_row("SELECT priority FROM element WHERE id=?1", [id], |r| r.get(0)).map_err(e)
}

/// First due day for new material: tomorrow, unless tomorrow is already over
/// the daily budget; then the least loaded of the next three days. Keeps the
/// forecast flat instead of fixing a pile-up with Mercy afterwards.
fn smooth_due(conn: &Connection, table: &str, day: i64) -> Result<i64> {
    let s = get_settings(conn)?;
    let budget = if table == "item" { s.item_budget } else { s.topic_budget };
    let load = |d: i64| -> Result<i64> {
        conn.query_row(
            &format!("SELECT COUNT(*) FROM {table} x JOIN element e ON e.id = x.element_id WHERE e.status='active' AND x.due_day = ?1"),
            [d],
            |r| r.get(0),
        )
        .map_err(e)
    };
    if load(day + 1)? < budget {
        return Ok(day + 1);
    }
    let mut best = (day + 1, i64::MAX);
    for d in day + 1..=day + 3 {
        let n = load(d)?;
        if n < best.1 {
            best = (d, n);
        }
    }
    Ok(best.0)
}

/// New extract: a child topic that inherits its parent's priority and comes back tomorrow.
pub fn create_extract(conn: &Connection, parent: i64, title: &str, doc_json: &str, day: i64) -> Result<i64> {
    let title = if title.trim().is_empty() { short_title(&doc_text(doc_json)) } else { title.trim().to_string() };
    let id = insert_element(conn, "topic", Some(parent), &title, Place::After(parent), "active")?;
    let priority = priority_of(conn, id)?;
    conn.execute(
        "INSERT INTO topic (element_id, doc_json, afactor, interval_days, due_day) VALUES (?1,?2,?3,1,?4)",
        params![id, doc_json, initial_afactor(doc_text(doc_json).len(), priority), smooth_due(conn, "topic", day)?],
    )
    .map_err(e)?;
    simple_log(conn, id, day, "create", Some(1))?;
    index(conn, id)?;
    Ok(id)
}

/// New question/answer item (clozes are Q&A items too). Both sides are
/// ProseMirror documents. First due tomorrow.
pub fn create_item(conn: &Connection, parent: Option<i64>, item_type: &str, question: &str, answer: &str, day: i64) -> Result<i64> {
    let place = parent.map_or(Place::Percent(50.0), Place::After);
    let id = insert_element(conn, "item", parent, &short_title(&doc_text(question)), place, "active")?;
    conn.execute(
        "INSERT INTO item (element_id, item_type, question, answer, due_day) VALUES (?1,?2,?3,?4,?5)",
        params![id, item_type, question, answer, smooth_due(conn, "item", day)?],
    )
    .map_err(e)?;
    simple_log(conn, id, day, "create", Some(1))?;
    index(conn, id)?;
    Ok(id)
}

pub fn save_topic(conn: &Connection, id: i64, doc_json: &str, read_point: Option<i64>) -> Result<()> {
    conn.execute("UPDATE topic SET doc_json=?2, read_point=?3 WHERE element_id=?1", params![id, doc_json, read_point]).map_err(e)?;
    touch(conn, id)?;
    index(conn, id)
}

/// Append lines to a topic as paragraphs (texthooker), atomically in the core
/// so lines arriving quickly can't overwrite each other. A `heading` line
/// (e.g. the session date) can come first. Returns the new text length.
pub fn append_lines(conn: &Connection, id: i64, lines: &[String], heading: Option<&str>) -> Result<i64> {
    let doc: String = conn.query_row("SELECT doc_json FROM topic WHERE element_id=?1", [id], |r| r.get(0)).map_err(e)?;
    let mut v: Value = serde_json::from_str(&doc).unwrap_or_else(|_| serde_json::json!({ "type": "doc", "content": [] }));
    let content = v.get_mut("content").and_then(Value::as_array_mut).ok_or("bad document")?;
    // Drop a lone empty paragraph (a new, empty topic).
    if content.len() == 1 && content[0].get("content").is_none() && content[0]["type"] == "paragraph" {
        content.clear();
    }
    if let Some(h) = heading.filter(|h| !h.trim().is_empty()) {
        content.push(serde_json::json!({ "type": "heading", "attrs": { "level": 3 }, "content": [{ "type": "text", "text": h.trim() }] }));
    }
    for l in lines.iter().map(|l| l.trim()).filter(|l| !l.is_empty()) {
        content.push(serde_json::json!({ "type": "paragraph", "content": [{ "type": "text", "text": l }] }));
    }
    let rp: Option<i64> = conn.query_row("SELECT read_point FROM topic WHERE element_id=?1", [id], |r| r.get(0)).map_err(e)?;
    save_topic(conn, id, &v.to_string(), rp)?;
    conn.query_row("SELECT text_len FROM topic WHERE element_id=?1", [id], |r| r.get(0)).map_err(e)
}

/// Save an item's question and answer. The title follows the question unless
/// the user has renamed it.
pub fn save_item(conn: &Connection, id: i64, question: &str, answer: &str) -> Result<()> {
    let (title, old_q): (String, String) = conn
        .query_row("SELECT e.title, i.question FROM element e JOIN item i ON i.element_id=e.id WHERE e.id=?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .map_err(e)?;
    conn.execute("UPDATE item SET question=?2, answer=?3 WHERE element_id=?1", params![id, question, answer]).map_err(e)?;
    if title == short_title(&doc_text(&old_q)) || title == "Untitled" {
        conn.execute("UPDATE element SET title=?2 WHERE id=?1", params![id, short_title(&doc_text(question))]).map_err(e)?;
    }
    touch(conn, id)?;
    index(conn, id)
}

pub fn touch_pub(conn: &Connection, id: i64) -> Result<()> {
    touch(conn, id)
}

fn touch(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("UPDATE element SET updated_at=?2 WHERE id=?1", params![id, now_ts()]).map_err(e)?;
    Ok(())
}

/// Move an element to a percentile of the priority queue. Inbox elements just
/// remember the requested value until they are accepted.
pub fn set_priority(conn: &Connection, id: i64, priority: f64) -> Result<()> {
    let status: String = conn.query_row("SELECT status FROM element WHERE id=?1", [id], |r| r.get(0)).map_err(e)?;
    if status == "active" {
        place_at_percent(conn, id, priority)?;
        recompute_priorities(conn)?;
    } else {
        conn.execute("UPDATE element SET priority=?2 WHERE id=?1", params![id, priority.clamp(0.0, 100.0)]).map_err(e)?;
    }
    touch(conn, id)
}

pub fn set_title(conn: &Connection, id: i64, title: &str) -> Result<()> {
    conn.execute("UPDATE element SET title=?2 WHERE id=?1", params![id, title.trim()]).map_err(e)?;
    touch(conn, id)?;
    index(conn, id)
}

fn set_status(conn: &Connection, id: i64, status: &str, day: i64) -> Result<()> {
    conn.execute("UPDATE element SET status=?2 WHERE id=?1", params![id, status]).map_err(e)?;
    simple_log(conn, id, day, status, None)?;
    // The active set changed, so everyone's percentile shifts.
    recompute_priorities(conn)?;
    touch(conn, id)
}

/// Dismiss: leave the learning process, keep text and children.
pub fn dismiss(conn: &Connection, id: i64, day: i64) -> Result<()> {
    set_status(conn, id, "dismissed", day)
}

/// Done!: for a topic, the text is removed (kept in the archive so Restore can
/// bring it back) and the empty element stays as a holder for its children.
pub fn done(conn: &Connection, id: i64, day: i64) -> Result<()> {
    let doc: Option<String> = conn.query_row("SELECT doc_json FROM topic WHERE element_id=?1", [id], |r| r.get(0)).optional().map_err(e)?;
    if let Some(doc) = doc {
        if !doc_text(&doc).is_empty() {
            conn.execute("INSERT INTO topic_archive (element_id, doc_json, ts) VALUES (?1,?2,?3)", params![id, doc, now_ts()]).map_err(e)?;
        }
        conn.execute("UPDATE topic SET doc_json=?2, read_point=NULL WHERE element_id=?1", params![id, EMPTY_DOC]).map_err(e)?;
        index(conn, id)?;
    }
    set_status(conn, id, "done", day)
}

/// Undo Dismiss or Done!: back into the learning process (due now if it was
/// overdue). Text removed by Done! comes back if the topic is still empty.
pub fn restore(conn: &Connection, id: i64, day: i64) -> Result<()> {
    let topic: Option<String> = conn.query_row("SELECT doc_json FROM topic WHERE element_id=?1", [id], |r| r.get(0)).optional().map_err(e)?;
    if let Some(doc) = topic {
        if doc_text(&doc).is_empty() {
            let archived: Option<(i64, String)> = conn
                .query_row("SELECT id, doc_json FROM topic_archive WHERE element_id=?1 ORDER BY id DESC LIMIT 1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
                .optional()
                .map_err(e)?;
            if let Some((aid, doc)) = archived {
                conn.execute("UPDATE topic SET doc_json=?2 WHERE element_id=?1", params![id, doc]).map_err(e)?;
                conn.execute("DELETE FROM topic_archive WHERE id=?1", [aid]).map_err(e)?;
                index(conn, id)?;
            }
        }
    }
    set_status(conn, id, "active", day)
}

/// Inbox → queue, with the priority chosen during triage. Due today.
pub fn accept(conn: &Connection, id: i64, priority: f64, day: i64) -> Result<()> {
    conn.execute("UPDATE topic SET due_day=?2 WHERE element_id=?1", params![id, day]).map_err(e)?;
    conn.execute("UPDATE element SET status='active' WHERE id=?1", [id]).map_err(e)?;
    simple_log(conn, id, day, "active", None)?;
    place_at_percent(conn, id, priority)?;
    recompute_priorities(conn)?;
    touch(conn, id)
}

pub fn inbox(conn: &Connection) -> Result<Vec<InboxEntry>> {
    let mut stmt = conn
        .prepare(
            "SELECT e.id, e.title, e.priority, s.url, s.site, COALESCE(length(t.doc_json),0), e.created_at
             FROM element e LEFT JOIN source_ref s ON s.element_id=e.id LEFT JOIN topic t ON t.element_id=e.id
             WHERE e.status='inbox' ORDER BY e.created_at DESC",
        )
        .map_err(e)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(InboxEntry { id: r.get(0)?, title: r.get(1)?, priority: r.get(2)?, url: r.get(3)?, site: r.get(4)?, chars: r.get(5)?, created_at: r.get(6)? })
        })
        .map_err(e)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(e);
    rows
}

pub fn delete_element(conn: &Connection, id: i64) -> Result<()> {
    // Children are kept (moved up to the top level); pin their reference first.
    let kids: Vec<i64> = conn
        .prepare("SELECT id FROM element WHERE parent_id=?1")
        .map_err(e)?
        .query_map([id], |r| r.get(0))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    for k in kids {
        pin_reference(conn, k)?;
    }
    conn.execute("DELETE FROM search WHERE element_id=?1", [id]).map_err(e)?;
    conn.execute("DELETE FROM element WHERE id=?1", [id]).map_err(e)?;
    recompute_priorities(conn)
}

/// New topic written by the user: a note, or an empty root that groups
/// other elements. Empty topics stay out of the queue until they get text.
pub fn create_topic(conn: &Connection, parent: Option<i64>, title: &str, doc_json: &str, day: i64) -> Result<i64> {
    let place = parent.map_or(Place::Percent(50.0), Place::After);
    let title = if title.trim().is_empty() { "New topic".to_string() } else { title.trim().to_string() };
    let id = insert_element(conn, "topic", parent, &title, place, "active")?;
    let priority = priority_of(conn, id)?;
    conn.execute(
        "INSERT INTO topic (element_id, doc_json, afactor, interval_days, due_day) VALUES (?1,?2,?3,0,?4)",
        params![id, doc_json, initial_afactor(doc_text(doc_json).len(), priority), day + 1],
    )
    .map_err(e)?;
    simple_log(conn, id, day, "create", Some(1))?;
    index(conn, id)?;
    Ok(id)
}

/// Give an element its own copy of the reference it currently inherits, so
/// moving it elsewhere in the tree doesn't change where it came from.
fn pin_reference(conn: &Connection, id: i64) -> Result<()> {
    let own: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM source_ref WHERE element_id=?1)", [id], |r| r.get(0)).map_err(e)?;
    if own {
        return Ok(());
    }
    if let Some(r) = reference(conn, id)? {
        conn.execute(
            "INSERT INTO source_ref (element_id, url, author, site, accessed_at, title)
             SELECT ?1, url, author, site, accessed_at, ?3 FROM source_ref WHERE element_id=?2",
            params![id, r.source_id, r.title],
        )
        .map_err(e)?;
    }
    Ok(())
}

fn is_descendant_or_self(conn: &Connection, candidate: i64, root: i64) -> Result<bool> {
    conn.query_row(
        "WITH RECURSIVE down(id) AS (SELECT ?2 UNION ALL SELECT c.id FROM element c JOIN down ON c.parent_id = down.id)
         SELECT EXISTS(SELECT 1 FROM down WHERE id = ?1)",
        params![candidate, root],
        |r| r.get(0),
    )
    .map_err(e)
}

/// Reparent elements (`None` = top level). Refuses to move an element into
/// itself or one of its descendants.
pub fn move_elements(conn: &Connection, ids: &[i64], parent: Option<i64>) -> Result<usize> {
    let mut moved = 0;
    for &id in ids {
        if let Some(p) = parent {
            if is_descendant_or_self(conn, p, id)? {
                return Err("Can't move an element into itself or its own descendants".into());
            }
        }
    }
    for &id in ids {
        let current: Option<i64> = conn.query_row("SELECT parent_id FROM element WHERE id=?1", [id], |r| r.get(0)).map_err(e)?;
        if current == parent {
            continue;
        }
        pin_reference(conn, id)?;
        conn.execute("UPDATE element SET parent_id=?2 WHERE id=?1", params![id, parent]).map_err(e)?;
        touch(conn, id)?;
        moved += 1;
    }
    Ok(moved)
}

pub fn siblings(conn: &Connection, parent: Option<i64>) -> Result<Vec<i64>> {
    let mut stmt = conn
        .prepare("SELECT id FROM element WHERE parent_id IS ?1 AND status != 'inbox' ORDER BY position, id")
        .map_err(e)?;
    let ids = stmt.query_map([parent], |r| r.get(0)).map_err(e)?.collect::<rusqlite::Result<Vec<i64>>>().map_err(e);
    ids
}

fn renumber(conn: &Connection, ordered: &[i64]) -> Result<()> {
    for (i, id) in ordered.iter().enumerate() {
        conn.execute("UPDATE element SET position=?2 WHERE id=?1", params![id, (i + 1) as f64]).map_err(e)?;
    }
    Ok(())
}

/// Move elements under `parent` and place them, in the given order, just
/// before sibling `before` (or at the end when `before` is None).
pub fn place(conn: &Connection, ids: &[i64], parent: Option<i64>, before: Option<i64>) -> Result<()> {
    if let Some(b) = before {
        if ids.contains(&b) {
            return Ok(()); // dropping a block next to itself: nothing changes
        }
    }
    move_elements(conn, ids, parent)?;
    let mut order: Vec<i64> = siblings(conn, parent)?.into_iter().filter(|id| !ids.contains(id)).collect();
    let at = before.and_then(|b| order.iter().position(|&x| x == b)).unwrap_or(order.len());
    order.splice(at..at, ids.iter().copied());
    renumber(conn, &order)
}

/// Shift one element up (negative) or down among its siblings.
pub fn shift(conn: &Connection, id: i64, delta: i64) -> Result<()> {
    let parent: Option<i64> = conn.query_row("SELECT parent_id FROM element WHERE id=?1", [id], |r| r.get(0)).map_err(e)?;
    let mut order = siblings(conn, parent)?;
    let Some(i) = order.iter().position(|&x| x == id) else { return Ok(()) };
    let j = (i as i64 + delta).clamp(0, order.len() as i64 - 1) as usize;
    let item = order.remove(i);
    order.insert(j, item);
    renumber(conn, &order)
}

/// Sort a parent's children by priority (most important first), once.
pub fn sort_children_by_priority(conn: &Connection, parent: Option<i64>) -> Result<()> {
    let mut stmt = conn
        .prepare("SELECT id FROM element WHERE parent_id IS ?1 AND status != 'inbox' ORDER BY priority, position")
        .map_err(e)?;
    let order = stmt.query_map([parent], |r| r.get(0)).map_err(e)?.collect::<rusqlite::Result<Vec<i64>>>().map_err(e)?;
    renumber(conn, &order)
}

/// One action applied to many elements in one transaction.
pub fn bulk(conn: &Connection, ids: &[i64], action: &str, priority: Option<f64>, day: i64) -> Result<usize> {
    conn.execute_batch("SAVEPOINT bulk").map_err(e)?;
    let result = (|| {
        if action == "priority" {
            set_priority_many(conn, ids, priority.ok_or("priority missing")?)?;
            return Ok(ids.len());
        }
        for &id in ids {
            match action {
                "dismiss" => dismiss(conn, id, day)?,
                "done" => done(conn, id, day)?,
                "restore" => restore(conn, id, day)?,
                "delete" => {
                    // Deleting a parent and its child in one go: the child may already be gone.
                    let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM element WHERE id=?1)", [id], |r| r.get(0)).map_err(e)?;
                    if exists {
                        delete_element(conn, id)?
                    }
                }
                "read_today" => reschedule(conn, id, 0, day)?,
                other => return Err(format!("unknown action {other}")),
            }
        }
        Ok(ids.len())
    })();
    match result {
        Ok(n) => {
            conn.execute_batch("RELEASE bulk").map_err(e)?;
            Ok(n)
        }
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK TO bulk; RELEASE bulk");
            Err(err)
        }
    }
}

/// Subset review over several branches (each root plus descendants), no duplicates.
pub fn branches_queue(conn: &Connection, roots: &[i64], due_only: bool, day: i64) -> Result<Vec<QueueEntry>> {
    let mut seen = std::collections::HashSet::new();
    let mut rows = Vec::new();
    for &r in roots {
        for row in select_active(conn, Some(r), due_only.then_some(day))? {
            if seen.insert(row.id) {
                rows.push(row);
            }
        }
    }
    rows.sort_by(|a, b| a.priority.total_cmp(&b.priority).then(a.due_day.cmp(&b.due_day)));
    Ok(to_entries(rows))
}

// ---------- PDF topics ----------

#[derive(Deserialize, Debug)]
pub struct PdfImport {
    pub title: String,
    pub asset: String,
    pub priority: f64,
    pub url: Option<String>,
    pub author: Option<String>,
    pub parent: Option<i64>,
    #[serde(default)]
    pub inbox: bool,
}

/// A PDF topic: the file lives in assets; the reader shows its pages.
pub fn import_pdf(conn: &Connection, input: &PdfImport, day: i64) -> Result<i64> {
    let status = if input.inbox { "inbox" } else { "active" };
    let title = if input.title.trim().is_empty() { "PDF".to_string() } else { input.title.trim().to_string() };
    let id = insert_element(conn, "topic", input.parent, &title, Place::Percent(input.priority), status)?;
    conn.execute(
        "INSERT INTO topic (element_id, doc_json, afactor, interval_days, due_day, pdf_asset, pdf_page) VALUES (?1,?2,?3,0,?4,?5,1)",
        params![id, EMPTY_DOC, initial_afactor(20_000, input.priority), day, input.asset],
    )
    .map_err(e)?;
    conn.execute(
        "INSERT INTO source_ref (element_id, url, author, site, accessed_at) VALUES (?1,?2,?3,NULL,?4)",
        params![id, input.url, input.author, now_ts()],
    )
    .map_err(e)?;
    simple_log(conn, id, day, "create", Some(0))?;
    index(conn, id)?;
    Ok(id)
}

// ---------- Video topics ----------

/// Clip extract from a video topic: a child topic playing `start..end` of the
/// same video, with the matching part of the transcript (if any) as its text.
pub fn create_clip(conn: &Connection, parent: i64, title: &str, start: f64, end: f64, doc_json: &str, day: i64) -> Result<i64> {
    let video: Option<String> = conn.query_row("SELECT video_id FROM topic WHERE element_id=?1", [parent], |r| r.get(0)).map_err(e)?;
    let video = video.ok_or("Not a video topic")?;
    let (start, end) = (start.max(0.0), end.max(0.0));
    if end <= start {
        return Err("A clip needs an end after its start".into());
    }
    let id = create_extract(conn, parent, title, doc_json, day)?;
    conn.execute(
        "UPDATE topic SET video_id=?2, video_start=?3, video_end=?4, video_pos=?3 WHERE element_id=?1",
        params![id, video, start, end],
    )
    .map_err(e)?;
    index(conn, id)?;
    Ok(id)
}

/// Resume position (seconds), the video equivalent of a read point.
pub fn set_video_pos(conn: &Connection, id: i64, pos: f64) -> Result<()> {
    conn.execute("UPDATE topic SET video_pos=?2 WHERE element_id=?1", params![id, pos.max(0.0)]).map_err(e)?;
    Ok(())
}

pub fn set_pdf_page(conn: &Connection, id: i64, page: i64) -> Result<()> {
    conn.execute("UPDATE topic SET pdf_page=?2 WHERE element_id=?1", params![id, page.max(1)]).map_err(e)?;
    Ok(())
}

#[derive(Serialize, Deserialize, Debug)]
pub struct PdfMark {
    pub id: i64,
    pub child_id: Option<i64>,
    pub page: i64,
    /// [[x, y, w, h], ...] as fractions of the page size.
    pub rects: Vec<[f64; 4]>,
    pub kind: String,
}

pub fn add_pdf_mark(conn: &Connection, id: i64, child: Option<i64>, page: i64, rects: &[[f64; 4]], kind: &str) -> Result<i64> {
    conn.execute(
        "INSERT INTO pdf_mark (element_id, child_id, page, rects_json, kind) VALUES (?1,?2,?3,?4,?5)",
        params![id, child, page, serde_json::to_string(rects).map_err(e)?, kind],
    )
    .map_err(e)?;
    Ok(conn.last_insert_rowid())
}

pub fn pdf_marks(conn: &Connection, id: i64) -> Result<Vec<PdfMark>> {
    let mut stmt = conn.prepare("SELECT id, child_id, page, rects_json, kind FROM pdf_mark WHERE element_id=?1 ORDER BY page, id").map_err(e)?;
    let rows = stmt
        .query_map([id], |r| {
            let rects: String = r.get(3)?;
            Ok(PdfMark { id: r.get(0)?, child_id: r.get(1)?, page: r.get(2)?, rects: serde_json::from_str(&rects).unwrap_or_default(), kind: r.get(4)? })
        })
        .map_err(e)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(e);
    rows
}

pub fn delete_pdf_mark(conn: &Connection, mark_id: i64) -> Result<()> {
    conn.execute("DELETE FROM pdf_mark WHERE id=?1", [mark_id]).map_err(e)?;
    Ok(())
}

// ---------- Statistics ----------

#[derive(Serialize, Debug, Default)]
pub struct DayCount {
    pub day: i64,
    pub again: i64,
    pub pass: i64,
    pub topics: i64,
}

#[derive(Serialize, Debug, Default)]
pub struct ProtectionBand {
    pub label: String,
    pub total: i64,
    pub overdue: i64,
}

#[derive(Serialize, Debug, Default)]
pub struct SourceYield {
    pub id: i64,
    pub title: String,
    pub extracts: i64,
    pub items: i64,
    /// Minutes spent reading and reviewing this branch (where timed).
    pub minutes: f64,
}

#[derive(Serialize, Debug, Default)]
pub struct BandRetention {
    pub label: String,
    /// Desired retention at the band's middle.
    pub target: f64,
    pub actual: Option<f64>,
    pub reviews: i64,
}

#[derive(Serialize, Debug, Default)]
pub struct FullStats {
    pub today: i64,
    /// Reviews per day, last 30 days (oldest first).
    pub history: Vec<DayCount>,
    /// Items and topics due per day, next 30 days (today first; overdue counted today).
    pub forecast_items: Vec<i64>,
    pub forecast_topics: Vec<i64>,
    /// Share of mature reviews (elapsed ≥ 1 day) passed in the last 30 days.
    pub true_retention: Option<f64>,
    pub mature_reviews: i64,
    pub protection: Vec<ProtectionBand>,
    pub sources: Vec<SourceYield>,
    /// Average seconds per timed item review / topic read, last 30 days.
    pub seconds_per_review: Option<f64>,
    pub seconds_per_read: Option<f64>,
    /// Retention calibration: mature-review pass rate per priority band, vs. the target.
    pub retention_by_band: Vec<BandRetention>,
    /// Items that cost the most time (total seconds, all time).
    pub costly: Vec<CostlyItem>,
    pub by_status: Vec<(String, i64)>,
    pub training_samples: usize,
    pub optimized: bool,
}

pub fn full_stats(conn: &Connection, day: i64) -> Result<FullStats> {
    let mut s = FullStats { today: day, ..Default::default() };
    let mut hist: Vec<DayCount> = (day - 29..=day).map(|d| DayCount { day: d, ..Default::default() }).collect();
    {
        let mut stmt = conn
            .prepare("SELECT day, kind, grade FROM review_log WHERE day > ?1 - 30 AND kind IN ('grade','read')")
            .map_err(e)?;
        let rows = stmt.query_map([day], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<i64>>(2)?))).map_err(e)?;
        for row in rows {
            let (d, kind, grade) = row.map_err(e)?;
            if let Some(h) = hist.get_mut((d - (day - 29)) as usize) {
                match (kind.as_str(), grade) {
                    ("read", _) => h.topics += 1,
                    (_, Some(1)) => h.again += 1,
                    _ => h.pass += 1,
                }
            }
        }
    }
    s.history = hist;

    let forecast = |table: &str| -> Result<Vec<i64>> {
        let mut out = vec![0i64; 30];
        let extra = if table == "topic" { "AND t.text_len > 0" } else { "" };
        let alias = if table == "topic" { "t" } else { "i" };
        let sql = format!(
            "SELECT {alias}.due_day, COUNT(*) FROM {table} {alias} JOIN element e ON e.id = {alias}.element_id
             WHERE e.status='active' AND {alias}.due_day < ?1 + 30 {extra} GROUP BY {alias}.due_day"
        );
        let mut stmt = conn.prepare(&sql).map_err(e)?;
        let rows = stmt.query_map([day], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))).map_err(e)?;
        for row in rows {
            let (d, n) = row.map_err(e)?;
            out[(d - day).max(0) as usize] += n;
        }
        Ok(out)
    };
    s.forecast_items = forecast("item")?;
    s.forecast_topics = forecast("topic")?;

    let (passed, total): (i64, i64) = conn
        .query_row(
            "SELECT COALESCE(SUM(grade > 1), 0), COUNT(*) FROM review_log WHERE kind='grade' AND elapsed_days >= 1 AND day > ?1 - 30",
            [day],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(e)?;
    s.mature_reviews = total;
    s.true_retention = (total > 0).then(|| passed as f64 / total as f64);

    for (label, lo, hi) in [("top 10%", 0.0, 10.0), ("10–25%", 10.0, 25.0), ("25–50%", 25.0, 50.0), ("50–100%", 50.0, 100.01)] {
        let (total, overdue): (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(COALESCE(t.due_day, i.due_day) < ?1), 0)
                 FROM element e LEFT JOIN topic t ON t.element_id=e.id LEFT JOIN item i ON i.element_id=e.id
                 WHERE e.status='active' AND e.priority >= ?2 AND e.priority < ?3 AND (t.element_id IS NULL OR t.text_len > 0)",
                params![day, lo, hi],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(e)?;
        s.protection.push(ProtectionBand { label: label.into(), total, overdue });
    }

    {
        let mut stmt = conn
            .prepare(
                "WITH RECURSIVE down(root, id) AS (
                     SELECT e.id, e.id FROM element e WHERE e.parent_id IS NULL
                     UNION ALL SELECT down.root, c.id FROM element c JOIN down ON c.parent_id = down.id)
                 SELECT r.id, r.title, SUM(x.kind='topic' AND x.id != r.id), SUM(x.kind='item')
                 FROM down JOIN element r ON r.id = down.root JOIN element x ON x.id = down.id
                 GROUP BY r.id HAVING SUM(x.kind='item') > 0 OR SUM(x.kind='topic' AND x.id != r.id) > 0
                 ORDER BY 4 DESC, 3 DESC LIMIT 12",
            )
            .map_err(e)?;
        s.sources = stmt
            .query_map([], |r| Ok(SourceYield { id: r.get(0)?, title: r.get(1)?, extracts: r.get(2)?, items: r.get(3)?, minutes: 0.0 }))
            .map_err(e)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(e)?;
    }
    {
        let mut stmt = conn.prepare("SELECT status, COUNT(*) FROM element GROUP BY status ORDER BY 2 DESC").map_err(e)?;
        s.by_status = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?.collect::<rusqlite::Result<Vec<_>>>().map_err(e)?;
    }
    s.training_samples = training_samples(conn)?;
    s.optimized = setting(conn, "fsrs_params")?.is_some();
    let avg = |kind: &str| -> Result<Option<f64>> {
        conn.query_row(
            "SELECT AVG(duration_ms) / 1000.0 FROM review_log WHERE kind=?1 AND duration_ms > 0 AND day > ?2 - 30",
            params![kind, day],
            |r| r.get(0),
        )
        .map_err(e)
    };
    s.seconds_per_review = avg("grade")?;
    s.seconds_per_read = avg("read")?;
    let settings = get_settings(conn)?;
    for (label, lo, hi) in [("top 10%", 0.0, 10.0), ("10–25%", 10.0, 25.0), ("25–50%", 25.0, 50.0), ("50–100%", 50.0, 100.01)] {
        let (passed, total): (i64, i64) = conn
            .query_row(
                "SELECT COALESCE(SUM(l.grade > 1), 0), COUNT(*) FROM review_log l JOIN element e ON e.id = l.element_id
                 WHERE l.kind='grade' AND l.elapsed_days >= 1 AND l.day > ?1 - 90 AND e.priority >= ?2 AND e.priority < ?3",
                params![day, lo, hi],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(e)?;
        s.retention_by_band.push(BandRetention {
            label: label.into(),
            target: settings.retention_for((lo + f64::min(hi, 100.0)) / 2.0),
            actual: (total > 0).then(|| passed as f64 / total as f64),
            reviews: total,
        });
    }
    {
        let mut stmt = conn
            .prepare(
                "SELECT e.id, e.title, SUM(l.duration_ms) / 1000.0, COALESCE(i.lapses, 0) FROM review_log l
                 JOIN element e ON e.id = l.element_id JOIN item i ON i.element_id = e.id
                 WHERE l.kind='grade' AND l.duration_ms > 0 AND e.status='active'
                 GROUP BY e.id ORDER BY 3 DESC LIMIT 10",
            )
            .map_err(e)?;
        s.costly = stmt
            .query_map([], |r| Ok(CostlyItem { id: r.get(0)?, title: r.get(1)?, seconds: r.get(2)?, lapses: r.get(3)? }))
            .map_err(e)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(e)?;
    }
    for src in s.sources.iter_mut() {
        src.minutes = conn
            .query_row(
                "WITH RECURSIVE down(id) AS (SELECT ?1 UNION ALL SELECT c.id FROM element c JOIN down ON c.parent_id = down.id)
                 SELECT COALESCE(SUM(duration_ms), 0) / 60000.0 FROM review_log WHERE element_id IN (SELECT id FROM down)",
                [src.id],
                |r| r.get(0),
            )
            .map_err(e)?;
    }
    Ok(s)
}

// ---------- Topic scheduling ----------

pub fn next_topic_interval(interval: i64, afactor: f64) -> i64 {
    if interval <= 0 {
        1
    } else {
        ((interval as f64 * afactor).round() as i64).max(interval + 1)
    }
}

/// The topic was read today: grow its interval by its A-Factor.
pub fn topic_read(conn: &Connection, id: i64, day: i64) -> Result<i64> {
    let (interval, af): (i64, f64) = conn
        .query_row("SELECT interval_days, afactor FROM topic WHERE element_id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(e)?;
    let next = next_topic_interval(interval, af);
    conn.execute(
        "UPDATE topic SET interval_days=?2, due_day=?3, last_day=?4 WHERE element_id=?1",
        params![id, next, day + next, day],
    )
    .map_err(e)?;
    simple_log(conn, id, day, "read", Some(next))?;
    Ok(next)
}

/// Set a topic's A-Factor (how fast its intervals grow), within 1.05–5.
pub fn set_afactor(conn: &Connection, id: i64, afactor: f64) -> Result<()> {
    if !afactor.is_finite() {
        return Err("invalid A-Factor".into());
    }
    let n = conn
        .execute("UPDATE topic SET afactor=?2 WHERE element_id=?1", params![id, (afactor.clamp(1.05, 5.0) * 100.0).round() / 100.0])
        .map_err(e)?;
    if n == 0 {
        return Err("Only topics have an A-Factor".into());
    }
    touch(conn, id)
}

/// Set the next review explicitly, `days` from today (topics or items). Does
/// not count as a repetition.
pub fn reschedule(conn: &Connection, id: i64, days: i64, day: i64) -> Result<()> {
    let days = days.max(0);
    let table = kind_table(conn, id)?;
    conn.execute(&format!("UPDATE {table} SET due_day=?2 WHERE element_id=?1"), params![id, day + days]).map_err(e)?;
    simple_log(conn, id, day, "reschedule", Some(days))
}

fn kind_table(conn: &Connection, id: i64) -> Result<&'static str> {
    let kind: String = conn.query_row("SELECT kind FROM element WHERE id=?1", [id], |r| r.get(0)).map_err(e)?;
    Ok(if kind == "topic" { "topic" } else { "item" })
}

// ---------- Item scheduling (FSRS) ----------

/// FSRS parameters: optimized ones if the optimizer has run, else defaults.
pub fn fsrs_params(conn: &Connection) -> Result<Vec<f32>> {
    Ok(setting(conn, "fsrs_params")?
        .and_then(|s| serde_json::from_str::<Vec<f32>>(&s).ok())
        .filter(|p| p.len() == fsrs::DEFAULT_PARAMETERS.len())
        .unwrap_or_else(|| fsrs::DEFAULT_PARAMETERS.to_vec()))
}

pub fn fsrs_from(params: &[f32]) -> FSRS {
    FSRS::new(params).unwrap_or_else(|_| FSRS::new(&fsrs::DEFAULT_PARAMETERS).expect("default FSRS parameters are valid"))
}

#[cfg(test)]
pub fn fsrs() -> FSRS {
    fsrs_from(&fsrs::DEFAULT_PARAMETERS)
}

/// FSRS-6 forgetting curve: days after which recall probability drops to `r`.
fn days_until_retention(stability: f64, r: f64, decay: f64) -> f64 {
    let factor = 0.9f64.powf(-1.0 / decay) - 1.0;
    stability / factor * (r.powf(-1.0 / decay) - 1.0)
}

/// Review histories in the shape the FSRS optimizer wants: for every item,
/// one training sample per review after the first (each a prefix of the history).
fn training_set(conn: &Connection) -> Result<(Vec<fsrs::FSRSItem>, Vec<i64>)> {
    let mut stmt = conn
        .prepare("SELECT element_id, grade, COALESCE(elapsed_days, 0) FROM review_log WHERE kind='grade' AND grade BETWEEN 1 AND 4 ORDER BY element_id, id")
        .map_err(e)?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)))
        .map_err(e)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(e)?;
    let mut items = Vec::new();
    let mut ids = Vec::new();
    let mut i = 0;
    while i < rows.len() {
        let id = rows[i].0;
        let mut history: Vec<fsrs::FSRSReview> = Vec::new();
        while i < rows.len() && rows[i].0 == id {
            let delta = if history.is_empty() { 0 } else { rows[i].2.max(0) as u32 };
            history.push(fsrs::FSRSReview { rating: rows[i].1 as u32, delta_t: delta });
            if history.len() >= 2 && delta > 0 {
                items.push(fsrs::FSRSItem { reviews: history.clone() });
                ids.push(id);
            }
            i += 1;
        }
    }
    Ok((items, ids))
}

#[derive(Serialize, Debug)]
pub struct OptimizeResult {
    pub samples: usize,
    pub parameters: Vec<f32>,
}

/// Minimum training samples before the optimizer is worth running.
pub const MIN_TRAINING_SAMPLES: usize = 400;

/// The optimizer's training data (read under the database lock).
pub struct TrainingData(Vec<fsrs::FSRSItem>, Vec<i64>);

pub fn training_data(conn: &Connection) -> Result<TrainingData> {
    let (items, ids) = training_set(conn)?;
    Ok(TrainingData(items, ids))
}

/// Fit FSRS parameters (slow; no database access, so it runs without the lock).
pub fn fit_parameters(data: TrainingData) -> Result<OptimizeResult> {
    let TrainingData(train_set, card_ids) = data;
    if train_set.len() < MIN_TRAINING_SAMPLES {
        return Err(format!(
            "Not enough review history yet: {} samples, need at least {MIN_TRAINING_SAMPLES}. Keep reviewing; defaults are fine until then.",
            train_set.len()
        ));
    }
    let samples = train_set.len();
    let parameters = fsrs::compute_parameters(fsrs::ComputeParametersInput { train_set, card_ids: Some(card_ids), ..Default::default() }).map_err(e)?;
    Ok(OptimizeResult { samples, parameters })
}

pub fn save_parameters(conn: &Connection, parameters: &[f32]) -> Result<()> {
    put_setting(conn, "fsrs_params", &serde_json::to_string(parameters).map_err(e)?)
}

pub fn reset_parameters(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM settings WHERE key='fsrs_params'", []).map_err(e)?;
    Ok(())
}

pub fn training_samples(conn: &Connection) -> Result<usize> {
    Ok(training_set(conn)?.0.len())
}

struct ItemSched {
    id: i64,
    stability: Option<f64>,
    difficulty: Option<f64>,
    last_day: Option<i64>,
    priority: f64,
}

fn item_sched(conn: &Connection, id: i64) -> Result<ItemSched> {
    conn.query_row(
        "SELECT i.stability, i.difficulty, i.last_day, e.priority FROM item i JOIN element e ON e.id=i.element_id WHERE i.element_id=?1",
        [id],
        |r| Ok(ItemSched { id, stability: r.get(0)?, difficulty: r.get(1)?, last_day: r.get(2)?, priority: r.get(3)? }),
    )
    .map_err(e)
}

fn next_states(conn: &Connection, f: &FSRS, s: &ItemSched, day: i64) -> Result<(fsrs::NextStates, i64)> {
    let memory = match (s.stability, s.difficulty) {
        (Some(st), Some(d)) => Some(MemoryState { stability: st as f32, difficulty: d as f32 }),
        _ => None,
    };
    // Early (mid-interval) reviews pass the true elapsed time; FSRS accounts for it.
    let elapsed = s.last_day.map(|l| (day - l).max(0)).unwrap_or(0);
    let retention = (get_settings(conn)?.retention_for(s.priority)).max(cram_retention(conn, s.id, day)?) as f32;
    let states = f.next_states(memory, retention, elapsed as u32).map_err(e)?;
    Ok((states, elapsed))
}

fn days(interval: f32) -> i64 {
    (interval.round() as i64).max(1)
}

/// Interval in days per grade (1 = Again .. 4 = Easy). 0 means "again today".
pub fn preview_item(conn: &Connection, f: &FSRS, id: i64, day: i64) -> Result<[i64; 4]> {
    let (n, _) = next_states(conn, f, &item_sched(conn, id)?, day)?;
    Ok([0, days(n.hard.interval), days(n.good.interval), days(n.easy.interval)])
}

/// Grade an item. Returns the new interval (0 = due again today).
pub fn grade_item(conn: &Connection, f: &FSRS, id: i64, grade: i64, day: i64) -> Result<i64> {
    let (n, elapsed) = next_states(conn, f, &item_sched(conn, id)?, day)?;
    let (state, interval) = match grade {
        1 => (n.again, 0),
        2 => {
            let i = days(n.hard.interval);
            (n.hard, i)
        }
        3 => {
            let i = days(n.good.interval);
            (n.good, i)
        }
        4 => {
            let i = days(n.easy.interval);
            (n.easy, i)
        }
        _ => return Err(format!("invalid grade {grade}")),
    };
    let st = state.memory.stability as f64;
    let df = state.memory.difficulty as f64;
    conn.execute(
        "UPDATE item SET stability=?2, difficulty=?3, interval_days=?4, due_day=?5, last_day=?6,
            reps=reps+1, lapses=lapses+(?7) WHERE element_id=?1",
        params![id, st, df, interval, day + interval, day, (grade == 1) as i64],
    )
    .map_err(e)?;
    log(conn, id, day, "grade", Some(grade), Some(elapsed), Some(interval), Some(st), Some(df))?;
    Ok(interval)
}

// ---------- Subsets ----------

/// Condition restricting `e.id` to a branch (root and all descendants), or
/// everything when the root parameter is NULL. `p` is the parameter index.
fn branch_sql(p: usize) -> String {
    format!(
        "(?{p} IS NULL OR e.id IN (WITH RECURSIVE down(id) AS (SELECT ?{p} UNION ALL SELECT c.id FROM element c JOIN down ON c.parent_id = down.id) SELECT id FROM down))"
    )
}

#[derive(Debug, Clone)]
struct DueRow {
    id: i64,
    kind: String,
    title: String,
    priority: f64,
    due_day: i64,
    interval: i64,
    afactor: Option<f64>,
    stability: Option<f64>,
    last_day: Option<i64>,
}

/// Active elements in a branch, optionally only those due by `day`.
fn select_active(conn: &Connection, root: Option<i64>, due_by: Option<i64>) -> Result<Vec<DueRow>> {
    let sql = format!(
        "SELECT e.id, e.kind, e.title, e.priority, COALESCE(t.due_day, i.due_day), COALESCE(t.interval_days, i.interval_days),
                t.afactor, i.stability, COALESCE(t.last_day, i.last_day)
         FROM element e
         LEFT JOIN topic t ON t.element_id = e.id
         LEFT JOIN item  i ON i.element_id = e.id
         WHERE e.status = 'active' AND (?1 IS NULL OR COALESCE(t.due_day, i.due_day) <= ?1)
           AND (t.element_id IS NULL OR t.text_len > 0) AND {}
         ORDER BY e.priority ASC, 5 ASC, e.id ASC",
        branch_sql(2)
    );
    let mut stmt = conn.prepare(&sql).map_err(e)?;
    let rows = stmt
        .query_map(params![due_by, root], |r| {
            Ok(DueRow {
                id: r.get(0)?,
                kind: r.get(1)?,
                title: r.get(2)?,
                priority: r.get(3)?,
                due_day: r.get(4)?,
                interval: r.get(5)?,
                afactor: r.get(6)?,
                stability: r.get(7)?,
                last_day: r.get(8)?,
            })
        })
        .map_err(e)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(e);
    rows
}

fn to_entries(rows: Vec<DueRow>) -> Vec<QueueEntry> {
    let (topics, items): (Vec<_>, Vec<_>) = rows
        .into_iter()
        .map(|r| QueueEntry { id: r.id, kind: r.kind, title: r.title, priority: r.priority, due_day: r.due_day })
        .partition(|q| q.kind == "topic");
    interleave(items, topics, ITEMS_PER_TOPIC)
}

fn interleave(items: Vec<QueueEntry>, topics: Vec<QueueEntry>, per_topic: usize) -> Vec<QueueEntry> {
    let mut out = Vec::with_capacity(items.len() + topics.len());
    let mut items = items.into_iter().peekable();
    let mut topics = topics.into_iter().peekable();
    while items.peek().is_some() || topics.peek().is_some() {
        out.extend(items.by_ref().take(per_topic));
        out.extend(topics.next());
    }
    out
}

// ---------- Exam (cram) mode ----------

/// Higher target retention for one branch until a date (an exam).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Cram {
    pub root: i64,
    pub title: String,
    pub retention: f64,
    /// Last learning day it applies to.
    pub until: i64,
}

pub fn get_cram(conn: &Connection) -> Result<Vec<Cram>> {
    Ok(setting(conn, "cram")?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default())
}

pub fn set_cram(conn: &Connection, list: &[Cram], day: i64) -> Result<()> {
    let kept: Vec<Cram> = list
        .iter()
        .filter(|c| c.until >= day)
        .map(|c| Cram { retention: c.retention.clamp(0.7, 0.99), ..c.clone() })
        .collect();
    put_setting(conn, "cram", &serde_json::to_string(&kept).map_err(e)?)
}

/// The highest exam retention that covers `id` today (0 if none).
fn cram_retention(conn: &Connection, id: i64, day: i64) -> Result<f64> {
    let mut best: f64 = 0.0;
    for c in get_cram(conn)? {
        if c.until >= day && c.retention > best && is_descendant_or_self(conn, id, c.root)? {
            best = c.retention;
        }
    }
    Ok(best)
}

// ---------- Queue ----------

/// Today's queue. The first call of a learning day runs auto-postpone.
pub fn queue(conn: &Connection, day: i64) -> Result<QueueResult> {
    let last: Option<i64> = setting(conn, "last_prepared_day")?.and_then(|s| s.parse().ok());
    let auto_postponed = if last.map_or(true, |l| l < day) {
        let report = auto_postpone(conn, day, &get_settings(conn)?)?;
        put_setting(conn, "last_prepared_day", &day.to_string())?;
        Some(report)
    } else {
        None
    };
    Ok(QueueResult { entries: to_entries(space_siblings(conn, select_active(conn, None, Some(day))?)?), auto_postponed })
}

/// One item per parent per day (the most important): siblings made from the
/// same passage give each other's answers away. The rest stay due and come
/// up on the following days. Subset reviews don't do this.
fn space_siblings(conn: &Connection, rows: Vec<DueRow>) -> Result<Vec<DueRow>> {
    let mut stmt = conn.prepare("SELECT parent_id FROM element WHERE id=?1").map_err(e)?;
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        if r.kind == "item" {
            let parent: Option<i64> = stmt.query_row([r.id], |x| x.get(0)).map_err(e)?;
            if let Some(p) = parent {
                if !seen.insert(p) {
                    continue;
                }
            }
        }
        out.push(r);
    }
    Ok(out)
}

/// Review a given set (e.g. search results), in priority order.
pub fn ids_queue(conn: &Connection, ids: &[i64]) -> Result<Vec<QueueEntry>> {
    let wanted: std::collections::HashSet<i64> = ids.iter().copied().collect();
    let rows = select_active(conn, None, None)?.into_iter().filter(|r| wanted.contains(&r.id)).collect();
    Ok(to_entries(rows))
}

/// Overload: keep the daily load within budget by postponing the least
/// important due elements. High-priority elements are protected. Items are
/// delayed only as long as their predicted recall stays above the floor.
pub fn auto_postpone(conn: &Connection, day: i64, s: &Settings) -> Result<PostponeReport> {
    let rows = select_active(conn, None, Some(day))?;
    let (topics, items): (Vec<_>, Vec<_>) = rows.into_iter().partition(|r| r.kind == "topic");
    let mut report = PostponeReport::default();
    let decay = fsrs_params(conn)?[20] as f64;
    for (i, r) in items.iter().enumerate() {
        if (i as i64) < s.item_budget || r.priority < s.protect_priority {
            continue;
        }
        let delay = item_delay(r, day, s.retention_floor, decay);
        postpone_one(conn, r, delay, day)?;
        report.items += 1;
    }
    for (i, r) in topics.iter().enumerate() {
        if (i as i64) < s.topic_budget || r.priority < s.protect_priority {
            continue;
        }
        let delay = topic_delay(r);
        postpone_one(conn, r, delay, day)?;
        report.topics += 1;
    }
    Ok(report)
}

fn item_delay(r: &DueRow, day: i64, floor: f64, decay: f64) -> i64 {
    match (r.stability, r.last_day) {
        (Some(st), Some(last)) => {
            let elapsed = (day - last) as f64;
            let room = days_until_retention(st, floor, decay) - elapsed;
            (room.round() as i64).clamp(1, r.interval.max(1))
        }
        _ => 1, // never reviewed: just tomorrow
    }
}

fn topic_delay(r: &DueRow) -> i64 {
    let af = r.afactor.unwrap_or(1.5);
    ((r.interval.max(1) as f64 * (af - 1.0)).round() as i64).max(1)
}

fn postpone_one(conn: &Connection, r: &DueRow, delay: i64, day: i64) -> Result<()> {
    let table = if r.kind == "topic" { "topic" } else { "item" };
    conn.execute(&format!("UPDATE {table} SET due_day=?2 WHERE element_id=?1"), params![r.id, day + delay]).map_err(e)?;
    simple_log(conn, r.id, day, "postpone", Some(delay))
}

#[derive(Deserialize, Debug, Clone)]
pub struct PostponeSpec {
    pub root: Option<i64>,
    pub topics: bool,
    pub items: bool,
    /// Only elements at least this unimportant (priority ≥ value).
    pub min_priority: f64,
    /// Delay = interval × (factor − 1), at least one day.
    pub factor: f64,
}

/// Manual postpone of due elements. With `simulate`, nothing changes and the
/// count is still returned.
pub fn postpone(conn: &Connection, spec: &PostponeSpec, simulate: bool, day: i64) -> Result<PostponeReport> {
    let mut report = PostponeReport::default();
    for r in select_active(conn, spec.root, Some(day))? {
        let is_topic = r.kind == "topic";
        if (is_topic && !spec.topics) || (!is_topic && !spec.items) || r.priority < spec.min_priority {
            continue;
        }
        let delay = ((r.interval.max(1) as f64 * (spec.factor.max(1.0) - 1.0)).round() as i64).max(1);
        if !simulate {
            postpone_one(conn, &r, delay, day)?;
        }
        if is_topic {
            report.topics += 1;
        } else {
            report.items += 1;
        }
    }
    Ok(report)
}

/// Mercy: spread everything due (in a branch, or all) evenly over `days`
/// days, most important first. Returns how many land on each day.
pub fn mercy(conn: &Connection, root: Option<i64>, spread_days: i64, simulate: bool, day: i64) -> Result<Vec<i64>> {
    let spread = spread_days.max(1);
    let rows = select_active(conn, root, Some(day))?;
    let n = rows.len() as i64;
    let mut per_day = vec![0i64; spread as usize];
    for (i, r) in rows.iter().enumerate() {
        let offset = (i as i64 * spread) / n.max(1);
        per_day[offset as usize] += 1;
        if !simulate && offset > 0 {
            postpone_one(conn, r, offset, day)?;
        }
    }
    Ok(per_day)
}

/// Before a break: everything that would come due in the next `away` days
/// (in a branch, or all) is pulled forward and spread over the next `lead`
/// days, most important first. Early reviews are fine: FSRS accounts for the
/// shorter elapsed time. Returns how many land on each lead day.
pub fn front_load(conn: &Connection, root: Option<i64>, away: i64, lead: i64, simulate: bool, day: i64) -> Result<Vec<i64>> {
    let lead = lead.max(1);
    let rows: Vec<DueRow> = select_active(conn, root, Some(day + away.max(1)))?.into_iter().filter(|r| r.due_day > day).collect();
    let n = rows.len() as i64;
    let mut per_day = vec![0i64; lead as usize];
    for (i, r) in rows.iter().enumerate() {
        let offset = (i as i64 * lead) / n.max(1);
        per_day[offset as usize] += 1;
        if !simulate {
            let table = if r.kind == "topic" { "topic" } else { "item" };
            conn.execute(&format!("UPDATE {table} SET due_day=?2 WHERE element_id=?1"), params![r.id, day + offset]).map_err(e)?;
            simple_log(conn, r.id, day, "reschedule", Some(offset))?;
        }
    }
    Ok(per_day)
}

/// Elements `front_load` would move (for undo).
pub fn upcoming_ids(conn: &Connection, root: Option<i64>, away: i64, day: i64) -> Result<Vec<i64>> {
    Ok(select_active(conn, root, Some(day + away.max(1)))?.into_iter().filter(|r| r.due_day > day).map(|r| r.id).collect())
}

// ---------- Search ----------

/// Full-text search over titles and text. Each word matches as a prefix.
pub fn search(conn: &Connection, query: &str, limit: i64) -> Result<Vec<i64>> {
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|w| w.chars().filter(|c| c.is_alphanumeric()).collect::<String>())
        .filter(|w| !w.is_empty())
        .map(|w| format!("\"{w}\"*"))
        .collect();
    if terms.is_empty() {
        return Ok(vec![]);
    }
    let mut stmt = conn.prepare("SELECT element_id FROM search WHERE search MATCH ?1 ORDER BY rank LIMIT ?2").map_err(e)?;
    let ids = stmt
        .query_map(params![terms.join(" "), limit], |r| r.get(0))
        .map_err(e)?
        .collect::<rusqlite::Result<Vec<i64>>>()
        .map_err(e);
    ids
}

pub fn stats(conn: &Connection, day: i64) -> Result<Stats> {
    let count = |sql: &str| -> Result<i64> { conn.query_row(sql, [day], |r| r.get(0)).map_err(e) };
    Ok(Stats {
        today: day,
        due_topics: count("SELECT COUNT(*) FROM topic t JOIN element e ON e.id=t.element_id WHERE e.status='active' AND t.due_day<=?1")?,
        due_items: count("SELECT COUNT(*) FROM item i JOIN element e ON e.id=i.element_id WHERE e.status='active' AND i.due_day<=?1")?,
        inbox: count("SELECT COUNT(*) FROM element WHERE status='inbox' AND ?1 IS NOT NULL")?,
        total_topics: count("SELECT COUNT(*) FROM topic WHERE ?1 IS NOT NULL")?,
        total_items: count("SELECT COUNT(*) FROM item WHERE ?1 IS NOT NULL")?,
    })
}

// ---------- Reading elements ----------

/// The nearest ancestor (or self) that carries a source reference.
pub fn reference(conn: &Connection, id: i64) -> Result<Option<Reference>> {
    conn.query_row(
        "WITH RECURSIVE up(id, parent_id, depth) AS (
             SELECT id, parent_id, 0 FROM element WHERE id = ?1
             UNION ALL
             SELECT e.id, e.parent_id, up.depth + 1 FROM element e JOIN up ON e.id = up.parent_id
         )
         SELECT e.id, COALESCE(s.title, e.title), s.url, s.author, s.site
         FROM up JOIN source_ref s ON s.element_id = up.id JOIN element e ON e.id = up.id
         ORDER BY up.depth LIMIT 1",
        [id],
        |r| Ok(Reference { source_id: r.get(0)?, title: r.get(1)?, url: r.get(2)?, author: r.get(3)?, site: r.get(4)? }),
    )
    .optional()
    .map_err(e)
}

pub fn get_element(conn: &Connection, id: i64) -> Result<ElementFull> {
    let mut el = conn
        .query_row(
            "SELECT e.id, e.kind, e.parent_id, p.title, e.title, e.priority, e.status,
                    (SELECT COUNT(*) FROM element c WHERE c.parent_id = e.id), e.pinned != 0, e.needs_work != 0
             FROM element e LEFT JOIN element p ON p.id = e.parent_id WHERE e.id = ?1",
            [id],
            |r| {
                Ok(ElementFull {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    parent_id: r.get(2)?,
                    parent_title: r.get(3)?,
                    title: r.get(4)?,
                    priority: r.get(5)?,
                    status: r.get(6)?,
                    children: r.get(7)?,
                    topic: None,
                    item: None,
                    reference: None,
                    queue_rank: 0,
                    queue_size: 0,
                    last_event: None,
                    ancestors: Vec::new(),
                    pinned: r.get(8)?,
                    needs_work: r.get(9)?,
                    tags: Vec::new(),
                })
            },
        )
        .map_err(e)?;
    (el.queue_rank, el.queue_size) = queue_rank(conn, id)?;
    el.last_event = conn
        .query_row(
            "SELECT kind FROM review_log WHERE element_id=?1 AND kind IN ('postpone','reschedule','read','grade','create') ORDER BY id DESC LIMIT 1",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(e)?;
    el.topic = conn
        .query_row(
            "SELECT doc_json, read_point, afactor, interval_days, due_day, last_day,
                    EXISTS(SELECT 1 FROM topic_archive a WHERE a.element_id = topic.element_id),
                    pdf_asset, pdf_page, text_len, video_id, video_start, video_end, video_pos
             FROM topic WHERE element_id=?1",
            [id],
            |r| {
                Ok(TopicData {
                    doc_json: r.get(0)?,
                    read_point: r.get(1)?,
                    afactor: r.get(2)?,
                    interval_days: r.get(3)?,
                    due_day: r.get(4)?,
                    last_day: r.get(5)?,
                    archived: r.get(6)?,
                    pdf_asset: r.get(7)?,
                    pdf_page: r.get(8)?,
                    text_len: r.get(9)?,
                    video_id: r.get(10)?,
                    video_start: r.get(11)?,
                    video_end: r.get(12)?,
                    video_pos: r.get(13)?,
                })
            },
        )
        .optional()
        .map_err(e)?;
    el.item = conn
        .query_row(
            "SELECT item_type, question, answer, stability, difficulty, interval_days, due_day, last_day, reps, lapses, fields_json
             FROM item WHERE element_id=?1",
            [id],
            |r| {
                Ok(ItemData {
                    item_type: r.get(0)?,
                    question: r.get(1)?,
                    answer: r.get(2)?,
                    stability: r.get(3)?,
                    difficulty: r.get(4)?,
                    interval_days: r.get(5)?,
                    due_day: r.get(6)?,
                    last_day: r.get(7)?,
                    reps: r.get(8)?,
                    lapses: r.get(9)?,
                    fields_json: r.get(10)?,
                })
            },
        )
        .optional()
        .map_err(e)?;
    el.reference = reference(conn, id)?;
    el.ancestors = ancestors(conn, id)?;
    el.tags = tags_of(conn, id)?;
    Ok(el)
}

/// Ancestors of `id`, top-level root first (excluding `id` itself).
pub fn ancestors(conn: &Connection, id: i64) -> Result<Vec<Crumb>> {
    let mut stmt = conn
        .prepare(
            "WITH RECURSIVE up(id, parent_id, depth) AS (
                 SELECT id, parent_id, 0 FROM element WHERE id = ?1
                 UNION ALL
                 SELECT e.id, e.parent_id, up.depth + 1 FROM element e JOIN up ON e.id = up.parent_id WHERE up.depth < 200
             )
             SELECT e.id, e.title FROM up JOIN element e ON e.id = up.id WHERE up.depth > 0 ORDER BY up.depth DESC",
        )
        .map_err(e)?;
    let rows = stmt
        .query_map([id], |r| Ok(Crumb { id: r.get(0)?, title: r.get(1)? }))
        .map_err(e)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(e);
    rows
}

/// Set a boolean flag on an element: `pinned` or `needs_work`.
pub fn set_flag(conn: &Connection, id: i64, flag: &str, value: bool) -> Result<()> {
    let col = match flag {
        "pinned" => "pinned",
        "needs_work" => "needs_work",
        other => return Err(format!("unknown flag {other}")),
    };
    conn.execute(&format!("UPDATE element SET {col}=?2 WHERE id=?1"), params![id, value as i64]).map_err(e)?;
    touch(conn, id)
}

/// What a learning session achieved, from the review log since `since_ts`.
#[derive(Serialize, Debug, Default, PartialEq)]
pub struct SessionSummary {
    pub topics_read: i64,
    pub items_graded: i64,
    pub items_again: i64,
    pub extracts: i64,
    pub items_created: i64,
    pub postponed: i64,
    pub done: i64,
}

pub fn session_summary(conn: &Connection, since_ts: i64) -> Result<SessionSummary> {
    conn.query_row(
        "SELECT COALESCE(SUM(l.kind='read'), 0),
                COALESCE(SUM(l.kind='grade'), 0),
                COALESCE(SUM(l.kind='grade' AND l.grade=1), 0),
                COALESCE(SUM(l.kind='create' AND e.kind='topic' AND e.parent_id IS NOT NULL), 0),
                COALESCE(SUM(l.kind='create' AND e.kind='item'), 0),
                COALESCE(SUM(l.kind IN ('postpone','reschedule')), 0),
                COALESCE(SUM(l.kind IN ('done','dismissed')), 0)
         FROM review_log l LEFT JOIN element e ON e.id = l.element_id WHERE l.ts >= ?1",
        [since_ts],
        |r| {
            Ok(SessionSummary {
                topics_read: r.get(0)?,
                items_graded: r.get(1)?,
                items_again: r.get(2)?,
                extracts: r.get(3)?,
                items_created: r.get(4)?,
                postponed: r.get(5)?,
                done: r.get(6)?,
            })
        },
    )
    .map_err(e)
}

/// An item as the Anki exporter needs it: both sides (ProseMirror JSON), the
/// deck (its top-level root) and the reference to show on the back.
#[derive(Serialize, Debug)]
pub struct ExportItem {
    pub id: i64,
    pub question: String,
    pub answer: String,
    pub deck: String,
    pub reference: Option<String>,
}

/// Active items, optionally only those in the given branches.
pub fn export_items(conn: &Connection, roots: Option<&[i64]>) -> Result<Vec<ExportItem>> {
    let wanted: Option<std::collections::HashSet<i64>> = match roots {
        None => None,
        Some(rs) => {
            let mut set = std::collections::HashSet::new();
            for &r in rs {
                for row in select_active(conn, Some(r), None)? {
                    set.insert(row.id);
                }
            }
            Some(set)
        }
    };
    let mut stmt = conn
        .prepare("SELECT e.id, i.question, i.answer FROM element e JOIN item i ON i.element_id = e.id WHERE e.status='active' ORDER BY e.prank, e.id")
        .map_err(e)?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))
        .map_err(e)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(e)?;
    let mut out = Vec::new();
    for (id, question, answer) in rows {
        if wanted.as_ref().is_some_and(|w| !w.contains(&id)) {
            continue;
        }
        let root = ancestors(conn, id)?.into_iter().next().map(|c| c.title);
        let reference = reference(conn, id)?.map(|r| match r.url {
            Some(u) => format!("{} — {u}", r.title),
            None => r.title,
        });
        out.push(ExportItem { id, question, answer, deck: root.unwrap_or_else(|| "Unsorted".into()), reference });
    }
    Ok(out)
}

/// One row of the element browser: everything the table can show, filter or sort by.
#[derive(Serialize, Debug)]
pub struct BrowseRow {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub kind: String,
    /// cloze, qa, occlusion; or text, pdf, video, note for topics.
    pub subtype: String,
    pub title: String,
    pub priority: f64,
    /// Position in the global priority queue.
    pub prank: f64,
    pub status: String,
    pub due_day: Option<i64>,
    pub interval_days: Option<i64>,
    pub last_day: Option<i64>,
    pub reps: i64,
    pub lapses: i64,
    pub stability: Option<f64>,
    /// Topics only.
    pub afactor: Option<f64>,
    /// Items: predicted recall today (FSRS).
    pub retrievability: Option<f64>,
    pub tags: Vec<String>,
    pub text_len: i64,
    pub children: i64,
    pub pinned: bool,
    pub needs_work: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Every element (inbox included) for the browser; filtering happens in the UI.
pub fn browse_rows(conn: &Connection, day: i64) -> Result<Vec<BrowseRow>> {
    let decay = fsrs_params(conn)?[20] as f64;
    let factor = 0.9f64.powf(-1.0 / decay) - 1.0;
    let mut stmt = conn
        .prepare(
            "SELECT e.id, e.parent_id, e.kind,
                    CASE WHEN i.element_id IS NOT NULL THEN i.item_type
                         WHEN t.pdf_asset IS NOT NULL THEN 'pdf'
                         WHEN t.video_id IS NOT NULL THEN 'video'
                         WHEN t.text_len = 0 THEN 'note' ELSE 'text' END,
                    e.title, e.priority, e.prank, e.status,
                    COALESCE(t.due_day, i.due_day), COALESCE(t.interval_days, i.interval_days), COALESCE(t.last_day, i.last_day),
                    COALESCE(i.reps, (SELECT COUNT(*) FROM review_log l WHERE l.element_id = e.id AND l.kind = 'read')),
                    COALESCE(i.lapses, 0), i.stability, COALESCE(t.text_len, 0),
                    (SELECT COUNT(*) FROM element c WHERE c.parent_id = e.id),
                    e.pinned != 0, e.needs_work != 0, e.created_at, e.updated_at, t.afactor,
                    (SELECT group_concat(g.name, char(31)) FROM element_tag et JOIN tag g ON g.id = et.tag_id WHERE et.element_id = e.id)
             FROM element e
             LEFT JOIN topic t ON t.element_id = e.id
             LEFT JOIN item  i ON i.element_id = e.id
             ORDER BY e.prank, e.id",
        )
        .map_err(e)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(BrowseRow {
                id: r.get(0)?,
                parent_id: r.get(1)?,
                kind: r.get(2)?,
                subtype: r.get(3)?,
                title: r.get(4)?,
                priority: r.get(5)?,
                prank: r.get(6)?,
                status: r.get(7)?,
                due_day: r.get(8)?,
                interval_days: r.get(9)?,
                last_day: r.get(10)?,
                reps: r.get(11)?,
                lapses: r.get(12)?,
                stability: r.get(13)?,
                text_len: r.get(14)?,
                children: r.get(15)?,
                pinned: r.get(16)?,
                needs_work: r.get(17)?,
                created_at: r.get(18)?,
                updated_at: r.get(19)?,
                afactor: r.get(20)?,
                tags: r.get::<_, Option<String>>(21)?.map(|t| t.split('\u{1f}').map(String::from).collect()).unwrap_or_default(),
                retrievability: None,
            })
        })
        .map_err(e)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(e)?;
    let mut rows = rows;
    for r in rows.iter_mut() {
        if let (Some(st), Some(last)) = (r.stability, r.last_day) {
            let t = (day - last).max(0) as f64;
            r.retrievability = Some((1.0 + factor * t / st.max(0.01)).powf(-decay));
        }
    }
    Ok(rows)
}

// ---------- Tags ----------

pub fn tags_of(conn: &Connection, id: i64) -> Result<Vec<String>> {
    let mut stmt = conn
        .prepare("SELECT g.name FROM element_tag et JOIN tag g ON g.id = et.tag_id WHERE et.element_id=?1 ORDER BY g.name")
        .map_err(e)?;
    let v = stmt.query_map([id], |r| r.get(0)).map_err(e)?.collect::<rusqlite::Result<Vec<String>>>().map_err(e);
    v
}

/// Replace an element's tags. Unused tags are removed.
pub fn set_tags(conn: &Connection, id: i64, names: &[String]) -> Result<()> {
    conn.execute("DELETE FROM element_tag WHERE element_id=?1", [id]).map_err(e)?;
    for n in names {
        let n = n.trim().trim_start_matches('#');
        if n.is_empty() {
            continue;
        }
        conn.execute("INSERT INTO tag (name) VALUES (?1) ON CONFLICT(name) DO NOTHING", [n]).map_err(e)?;
        conn.execute("INSERT OR IGNORE INTO element_tag (element_id, tag_id) SELECT ?1, id FROM tag WHERE name = ?2", params![id, n]).map_err(e)?;
    }
    conn.execute("DELETE FROM tag WHERE id NOT IN (SELECT tag_id FROM element_tag)", []).map_err(e)?;
    touch(conn, id)
}

/// Add (or remove) one tag on many elements.
pub fn tag_many(conn: &Connection, ids: &[i64], name: &str, add: bool) -> Result<()> {
    for &id in ids {
        let mut t = tags_of(conn, id)?;
        t.retain(|x| !x.eq_ignore_ascii_case(name));
        if add {
            t.push(name.to_string());
        }
        set_tags(conn, id, &t)?;
    }
    Ok(())
}

/// All tags with how many elements carry each.
pub fn all_tags(conn: &Connection) -> Result<Vec<(String, i64)>> {
    let mut stmt = conn
        .prepare("SELECT g.name, COUNT(*) FROM tag g JOIN element_tag et ON et.tag_id = g.id GROUP BY g.id ORDER BY g.name")
        .map_err(e)?;
    let v = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?.collect::<rusqlite::Result<Vec<_>>>().map_err(e);
    v
}

// ---------- Reading and review helpers ----------

/// Time spent on the latest log entry of `id` (the read or grade just made).
pub fn set_last_duration(conn: &Connection, id: i64, ms: i64) -> Result<()> {
    conn.execute(
        "UPDATE review_log SET duration_ms = ?2 WHERE id = (SELECT MAX(id) FROM review_log WHERE element_id = ?1 AND kind IN ('grade','read'))",
        params![id, ms.clamp(0, 30 * 60 * 1000)],
    )
    .map_err(e)?;
    Ok(())
}

#[derive(Serialize, Debug)]
pub struct Started {
    pub id: i64,
    pub title: String,
    pub priority: f64,
    pub due_day: i64,
    /// "text", "pdf" or "video", and where the reader is in it.
    pub kind: String,
    pub progress: Option<f64>,
}

/// Topics already started (read point, PDF page or video position set):
/// the "Continue reading" list, most important first.
pub fn continue_reading(conn: &Connection, limit: i64) -> Result<Vec<Started>> {
    let mut stmt = conn
        .prepare(
            "SELECT e.id, e.title, e.priority, t.due_day,
                    CASE WHEN t.pdf_asset IS NOT NULL THEN 'pdf' WHEN t.video_id IS NOT NULL THEN 'video' ELSE 'text' END,
                    CASE WHEN t.pdf_asset IS NULL AND t.video_id IS NULL AND length(t.doc_json) > 0
                         THEN MIN(1.0, t.read_point * 1.0 / MAX(1, t.text_len + 2 * (length(t.doc_json) - t.text_len) / 40)) END
             FROM element e JOIN topic t ON t.element_id = e.id
             WHERE e.status = 'active' AND t.text_len > 0
               AND (t.read_point > 1 OR t.pdf_page > 1 OR t.video_pos > 5)
             ORDER BY e.prank LIMIT ?1",
        )
        .map_err(e)?;
    let v = stmt
        .query_map([limit], |r| Ok(Started { id: r.get(0)?, title: r.get(1)?, priority: r.get(2)?, due_day: r.get(3)?, kind: r.get(4)?, progress: r.get(5)? }))
        .map_err(e)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(e);
    v
}

/// Priority audit: important topics nobody has touched in a long time.
/// Audited elements ("still important") stay off the list for 90 days.
pub fn priority_audit(conn: &Connection, day: i64) -> Result<Vec<Anchor>> {
    let mut stmt = conn
        .prepare(
            "SELECT e.id, e.title, e.priority FROM element e JOIN topic t ON t.element_id = e.id
             WHERE e.status = 'active' AND t.text_len > 0 AND e.priority < 15
               AND COALESCE(t.last_day, e.created_at / 86400) < ?1 - 45
               AND NOT EXISTS (SELECT 1 FROM review_log l WHERE l.element_id = e.id AND l.kind = 'audit' AND l.day > ?1 - 90)
             ORDER BY e.prank LIMIT 10",
        )
        .map_err(e)?;
    let v = stmt
        .query_map([day], |r| Ok(Anchor { id: r.get(0)?, title: r.get(1)?, priority: r.get(2)? }))
        .map_err(e)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(e);
    v
}

pub fn mark_audited(conn: &Connection, id: i64, day: i64) -> Result<()> {
    simple_log(conn, id, day, "audit", None)
}

#[derive(Serialize, Debug)]
pub struct CostlyItem {
    pub id: i64,
    pub title: String,
    pub seconds: f64,
    pub lapses: i64,
}

pub fn tree(conn: &Connection) -> Result<Vec<TreeNode>> {
    let mut stmt = conn
        .prepare(
            "SELECT e.id, e.parent_id, e.kind, e.title, e.priority, e.status, COALESCE(t.due_day, i.due_day),
                    t.text_len = 0, t.pdf_asset IS NOT NULL, e.position,
                    COALESCE(i.lapses, 0), e.pinned != 0, e.needs_work != 0, e.updated_at, t.video_id IS NOT NULL
             FROM element e
             LEFT JOIN topic t ON t.element_id = e.id
             LEFT JOIN item  i ON i.element_id = e.id
             WHERE e.status != 'inbox'
             ORDER BY e.position ASC, e.id ASC",
        )
        .map_err(e)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(TreeNode {
                id: r.get(0)?,
                parent_id: r.get(1)?,
                kind: r.get(2)?,
                title: r.get(3)?,
                priority: r.get(4)?,
                status: r.get(5)?,
                due_day: r.get(6)?,
                empty: r.get::<_, Option<bool>>(7)?.unwrap_or(false),
                pdf: r.get::<_, Option<bool>>(8)?.unwrap_or(false),
                position: r.get(9)?,
                lapses: r.get(10)?,
                pinned: r.get(11)?,
                needs_work: r.get(12)?,
                updated_at: r.get(13)?,
                video: r.get::<_, Option<bool>>(14)?.unwrap_or(false),
            })
        })
        .map_err(e)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(e);
    rows
}

/// Consistent copy of the collection into `dir`. Returns the file path.
pub fn backup(conn: &Connection, dir: &std::path::Path) -> Result<String> {
    std::fs::create_dir_all(dir).map_err(e)?;
    let name = format!("collection-{}.sqlite", chrono::Local::now().format("%Y%m%d-%H%M%S"));
    let path = dir.join(name);
    conn.execute("VACUUM INTO ?1", [path.to_string_lossy()]).map_err(e)?;
    Ok(path.to_string_lossy().into_owned())
}

// ---------- Undo ----------

/// Rows that together make up an element, keyed by the column naming it.
const SNAP_TABLES: &[(&str, &str)] = &[
    ("element", "id"),
    ("topic", "element_id"),
    ("item", "element_id"),
    ("source_ref", "element_id"),
    ("topic_archive", "element_id"),
    ("pdf_mark", "element_id"),
    ("pdf_mark", "child_id"),
    ("element_tag", "element_id"),
];

fn to_json(v: rusqlite::types::ValueRef) -> Value {
    use rusqlite::types::ValueRef::*;
    match v {
        Null => Value::Null,
        Integer(i) => Value::from(i),
        Real(f) => Value::from(f),
        Text(t) => Value::from(String::from_utf8_lossy(t).into_owned()),
        Blob(_) => Value::Null,
    }
}

fn to_sql(v: &Value) -> rusqlite::types::Value {
    use rusqlite::types::Value as V;
    match v {
        Value::Null => V::Null,
        Value::Bool(b) => V::Integer(*b as i64),
        Value::Number(n) => n.as_i64().map(V::Integer).unwrap_or_else(|| V::Real(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => V::Text(s.clone()),
        other => V::Text(other.to_string()),
    }
}

/// Copy of every row belonging to these elements, so an action can be undone.
pub fn snapshot(conn: &Connection, ids: &[i64]) -> Result<Value> {
    let mut entries = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for &id in ids {
        if !seen.insert(id) {
            continue;
        }
        for (table, col) in SNAP_TABLES {
            let mut stmt = conn.prepare(&format!("SELECT * FROM {table} WHERE {col} = ?1")).map_err(e)?;
            let names: Vec<String> = stmt.column_names().map(|s| s.to_string()).collect();
            let rows = stmt
                .query_map([id], |r| {
                    let mut m = serde_json::Map::new();
                    for (i, n) in names.iter().enumerate() {
                        m.insert(n.clone(), to_json(r.get_ref(i)?));
                    }
                    Ok(Value::Object(m))
                })
                .map_err(e)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(e)?;
            entries.push(serde_json::json!({ "id": id, "table": table, "col": col, "rows": rows }));
        }
    }
    Ok(Value::Array(entries))
}

/// Put snapshotted rows back. Element rows are upserted (never deleted, so
/// children keep their parent); the other tables are replaced per element.
pub fn restore_snapshot(conn: &Connection, snap: &Value) -> Result<()> {
    let entries = snap.as_array().ok_or("bad snapshot")?;
    conn.execute_batch("SAVEPOINT undo").map_err(e)?;
    let result = (|| {
        let insert = |table: &str, row: &serde_json::Map<String, Value>, upsert_key: Option<&str>| -> Result<()> {
            let cols: Vec<&String> = row.keys().collect();
            let placeholders: Vec<String> = (1..=cols.len()).map(|i| format!("?{i}")).collect();
            let col_list = cols.iter().map(|c| c.as_str()).collect::<Vec<_>>().join(", ");
            let tail = match upsert_key {
                Some(k) => format!(
                    " ON CONFLICT({k}) DO UPDATE SET {}",
                    cols.iter().filter(|c| c.as_str() != k).map(|c| format!("{c} = excluded.{c}")).collect::<Vec<_>>().join(", ")
                ),
                None => String::new(),
            };
            let verb = if upsert_key.is_some() { "INSERT" } else { "INSERT OR IGNORE" };
            let sql = format!("{verb} INTO {table} ({col_list}) VALUES ({}){tail}", placeholders.join(", "));
            let values: Vec<rusqlite::types::Value> = cols.iter().map(|c| to_sql(&row[*c])).collect();
            conn.execute(&sql, rusqlite::params_from_iter(values)).map_err(e)?;
            Ok(())
        };
        let mut ids = Vec::new();
        // Elements first (parents before children is not required: parent_id has no deferred check issues
        // because the referenced rows already exist or are restored in this same pass).
        conn.execute_batch("PRAGMA defer_foreign_keys = ON").map_err(e)?;
        for en in entries.iter().filter(|en| en["table"] == "element") {
            ids.push(en["id"].as_i64().unwrap_or(0));
            for row in en["rows"].as_array().into_iter().flatten() {
                if let Some(m) = row.as_object() {
                    insert("element", m, Some("id"))?;
                }
            }
        }
        for en in entries.iter().filter(|en| en["table"] != "element") {
            let table = en["table"].as_str().unwrap_or("");
            let col = en["col"].as_str().unwrap_or("");
            if !SNAP_TABLES.contains(&(table, col)) {
                continue;
            }
            conn.execute(&format!("DELETE FROM {table} WHERE {col} = ?1"), [en["id"].as_i64().unwrap_or(0)]).map_err(e)?;
            for row in en["rows"].as_array().into_iter().flatten() {
                if let Some(m) = row.as_object() {
                    insert(table, m, None)?;
                }
            }
        }
        recompute_priorities(conn)?;
        for id in ids {
            index(conn, id)?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => conn.execute_batch("RELEASE undo").map_err(e),
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK TO undo; RELEASE undo");
            Err(err)
        }
    }
}

/// Elements an action on `ids` can touch: themselves and their children
/// (deleting moves children, Done! keeps them).
pub fn with_children(conn: &Connection, ids: &[i64]) -> Result<Vec<i64>> {
    let mut out = ids.to_vec();
    for &id in ids {
        out.extend(siblings(conn, Some(id))?);
    }
    Ok(out)
}

/// Active, due elements in a branch (or everywhere): what postpone/mercy touch.
pub fn due_ids(conn: &Connection, root: Option<i64>, day: i64) -> Result<Vec<i64>> {
    Ok(select_active(conn, root, Some(day))?.into_iter().map(|r| r.id).collect())
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn doc(text: &str) -> String {
        serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":text}]}]}).to_string()
    }

    fn import(conn: &Connection, title: &str, priority: f64, day: i64) -> i64 {
        import_topic(
            conn,
            &ImportInput { title: title.into(), doc_json: doc(&format!("{title} body text")), priority, url: Some("https://example.org".into()), ..Default::default() },
            day,
        )
        .unwrap()
    }

    fn item(conn: &Connection, parent: i64, q: &str, day: i64) -> i64 {
        create_item(conn, Some(parent), "cloze", &doc(q), &doc("a"), day).unwrap()
    }

    #[test]
    fn extract_and_item_inherit_priority_and_reference() {
        let c = db::open_in_memory().unwrap();
        let src = import(&c, "Leptin", 10.0, 100);
        let ex = create_extract(&c, src, "", &doc("Leptin is made by fat cells."), 100).unwrap();
        let cz = item(&c, ex, "Leptin is made by [...] cells", 100);
        let el = get_element(&c, cz).unwrap();
        // Children enter the queue right after their parent.
        let (rs, re, rc) = (queue_rank(&c, src).unwrap().0, queue_rank(&c, ex).unwrap().0, queue_rank(&c, cz).unwrap().0);
        assert_eq!((re, rc), (rs + 1, re + 1));
        assert_eq!(el.parent_id, Some(ex));
        assert_eq!(el.title, "Leptin is made by [...] cells");
        let r = el.reference.unwrap();
        assert_eq!(r.source_id, src);
        assert_eq!(r.url.as_deref(), Some("https://example.org"));
        assert_eq!(el.item.unwrap().due_day, 101);
        assert_eq!(get_element(&c, ex).unwrap().title, "Leptin is made by fat cells.");
    }

    #[test]
    fn items_are_editable_and_title_follows_question() {
        let c = db::open_in_memory().unwrap();
        let t = import(&c, "A", 50.0, 100);
        let i = item(&c, t, "old question", 100);
        save_item(&c, i, &doc("new question"), &doc("new answer")).unwrap();
        let el = get_element(&c, i).unwrap();
        assert_eq!(el.title, "new question");
        assert_eq!(doc_text(&el.item.unwrap().answer), "new answer");
        set_title(&c, i, "My title").unwrap();
        save_item(&c, i, &doc("third"), &doc("x")).unwrap();
        assert_eq!(get_element(&c, i).unwrap().title, "My title");
    }

    #[test]
    fn topic_intervals_grow_by_afactor() {
        assert_eq!(next_topic_interval(0, 1.5), 1);
        assert_eq!(next_topic_interval(1, 1.5), 2);
        assert_eq!(next_topic_interval(4, 1.5), 6);
        assert_eq!(next_topic_interval(10, 2.0), 20);
        let c = db::open_in_memory().unwrap();
        let t = import(&c, "A", 50.0, 100);
        assert_eq!(topic_read(&c, t, 100).unwrap(), 1);
        assert!(queue(&c, 100).unwrap().entries.is_empty());
        assert_eq!(queue(&c, 101).unwrap().entries.len(), 1);
    }

    #[test]
    fn fsrs_grading_moves_due_date() {
        let c = db::open_in_memory().unwrap();
        let f = fsrs();
        let t = import(&c, "A", 50.0, 100);
        let i = item(&c, t, "q [...]", 100);
        let p = preview_item(&c, &f, i, 101).unwrap();
        assert!(p[1] <= p[2] && p[2] <= p[3], "{p:?}");
        let iv = grade_item(&c, &f, i, 3, 101).unwrap();
        let it = get_element(&c, i).unwrap().item.unwrap();
        assert_eq!((it.due_day, it.reps), (101 + iv, 1));
        let day = 101 + iv;
        assert_eq!(grade_item(&c, &f, i, 1, day).unwrap(), 0);
        let it = get_element(&c, i).unwrap().item.unwrap();
        assert_eq!((it.due_day, it.lapses), (day, 1));
    }

    #[test]
    fn queue_sorts_by_priority_and_interleaves() {
        let c = db::open_in_memory().unwrap();
        let low = import(&c, "low", 90.0, 100);
        let high = import(&c, "high", 5.0, 100);
        let items: Vec<i64> = (0..5).map(|n| item(&c, high, &format!("q{n}"), 99)).collect();
        let ids: Vec<i64> = queue(&c, 100).unwrap().entries.iter().map(|x| x.id).collect();
        // Each new item enters right after its parent, so the newest comes first;
        // siblings are spaced out, so only one of the five shows up today.
        assert_eq!(ids, vec![items[4], high, low]);
        dismiss(&c, low, 100).unwrap();
        assert_eq!(queue(&c, 100).unwrap().entries.len(), 2);
    }

    #[test]
    fn done_archives_text_and_restore_brings_it_back() {
        let c = db::open_in_memory().unwrap();
        let t = import(&c, "Article", 50.0, 100);
        let ex = create_extract(&c, t, "", &doc("kept"), 100).unwrap();
        done(&c, t, 100).unwrap();
        let el = get_element(&c, t).unwrap();
        assert_eq!(el.status, "done");
        assert_eq!(doc_text(&el.topic.as_ref().unwrap().doc_json), "");
        assert!(el.topic.unwrap().archived);
        assert_eq!(get_element(&c, ex).unwrap().status, "active");
        restore(&c, t, 100).unwrap();
        let el = get_element(&c, t).unwrap();
        assert_eq!(el.status, "active");
        assert_eq!(doc_text(&el.topic.unwrap().doc_json), "Article body text");
        // Dismiss keeps the text; restore just reactivates.
        dismiss(&c, t, 100).unwrap();
        restore(&c, t, 100).unwrap();
        assert_eq!(get_element(&c, t).unwrap().status, "active");
    }

    #[test]
    fn inbox_holds_imports_until_accepted() {
        let c = db::open_in_memory().unwrap();
        let id = import_topic(&c, &ImportInput { title: "New".into(), doc_json: doc("x"), priority: 50.0, inbox: true, ..Default::default() }, 100).unwrap();
        assert!(queue(&c, 100).unwrap().entries.is_empty());
        assert_eq!(inbox(&c).unwrap().len(), 1);
        assert!(tree(&c).unwrap().is_empty());
        accept(&c, id, 20.0, 105).unwrap();
        let q = queue(&c, 105).unwrap().entries;
        // The only active element is the whole queue: 0%.
        assert_eq!((q.len(), q[0].priority), (1, 0.0));
        assert!(inbox(&c).unwrap().is_empty());
    }

    #[test]
    fn auto_postpone_respects_budget_and_protection() {
        let c = db::open_in_memory().unwrap();
        let t = import(&c, "src", 50.0, 90);
        topic_read(&c, t, 90).unwrap();
        // 6 items due on day 100 at priorities 0, 20, 40, 60, 80, 95.
        // 6 items at the head of the queue, in this order (percentiles 0, 16.7, 33, …).
        let ids: Vec<i64> = (0..6).map(|n| item(&c, t, &format!("q{n}"), 99)).collect();
        set_priority_many(&c, &ids, 0.0).unwrap();
        let s = Settings { item_budget: 2, protect_priority: 10.0, ..Default::default() };
        let report = auto_postpone(&c, 100, &s).unwrap();
        assert_eq!(report, PostponeReport { items: 4, topics: 0 });
        let due: Vec<i64> = select_active(&c, None, Some(100)).unwrap().iter().filter(|r| r.kind == "item").map(|r| r.id).collect();
        assert_eq!(due, vec![ids[0], ids[1]]);
        // Runs once per day through queue().
        put_setting(&c, "settings", &serde_json::to_string(&s).unwrap()).unwrap();
        assert!(queue(&c, 101).unwrap().auto_postponed.is_some());
        assert!(queue(&c, 101).unwrap().auto_postponed.is_none());
    }

    #[test]
    fn postpone_simulate_changes_nothing_and_mercy_spreads() {
        let c = db::open_in_memory().unwrap();
        let t = import(&c, "src", 50.0, 100);
        for n in 0..9 {
            item(&c, t, &format!("q{n}"), 99);
        }
        let spec = PostponeSpec { root: Some(t), topics: true, items: true, min_priority: 0.0, factor: 2.0 };
        assert_eq!(postpone(&c, &spec, true, 100).unwrap(), PostponeReport { items: 9, topics: 1 });
        assert_eq!(select_active(&c, None, Some(100)).unwrap().len(), 10);
        assert_eq!(mercy(&c, None, 5, false, 100).unwrap(), vec![2, 2, 2, 2, 2]);
        assert_eq!(select_active(&c, None, Some(100)).unwrap().len(), 2);
        assert_eq!(select_active(&c, None, Some(104)).unwrap().len(), 10);
    }

    #[test]
    fn branch_review_and_search() {
        let c = db::open_in_memory().unwrap();
        let a = import(&c, "Mitochondria", 50.0, 100);
        let b = import(&c, "Photosynthesis", 50.0, 100);
        let ex = create_extract(&c, a, "", &doc("The powerhouse of the cell"), 100).unwrap();
        let qi = item(&c, ex, "ATP synthase makes [...]", 100);
        let early: Vec<i64> = branches_queue(&c, &[a], false, 100).unwrap().iter().map(|q| q.id).collect();
        assert_eq!(early.len(), 3);
        assert!(!early.contains(&b));
        assert_eq!(branches_queue(&c, &[a], true, 100).unwrap().len(), 1);
        assert_eq!(search(&c, "powerhou", 10).unwrap(), vec![ex]);
        assert_eq!(search(&c, "synthase", 10).unwrap(), vec![qi]);
        assert_eq!(search(&c, "photo", 10).unwrap(), vec![b]);
        assert!(search(&c, "\"; DROP", 10).unwrap().is_empty());
        delete_element(&c, ex).unwrap();
        assert!(search(&c, "powerhouse", 10).unwrap().is_empty());
    }

    #[test]
    fn moving_keeps_reference_and_refuses_cycles() {
        let c = db::open_in_memory().unwrap();
        let src = import(&c, "Source article", 50.0, 100);
        let ex = create_extract(&c, src, "", &doc("piece"), 100).unwrap();
        let sub = create_extract(&c, ex, "", &doc("smaller"), 100).unwrap();
        let folder = create_topic(&c, None, "Biology", r#"{"type":"doc","content":[{"type":"paragraph"}]}"#, 100).unwrap();
        assert!(move_elements(&c, &[ex], Some(sub)).is_err(), "into own descendant");
        assert!(move_elements(&c, &[ex], Some(ex)).is_err(), "into itself");
        assert_eq!(move_elements(&c, &[ex], Some(folder)).unwrap(), 1);
        let el = get_element(&c, ex).unwrap();
        assert_eq!(el.parent_id, Some(folder));
        let r = el.reference.unwrap();
        assert_eq!((r.title.as_str(), r.url.as_deref()), ("Source article", Some("https://example.org")));
        // The grandchild still finds the reference through its moved parent.
        assert_eq!(get_element(&c, sub).unwrap().reference.unwrap().title, "Source article");
        assert_eq!(move_elements(&c, &[ex], None).unwrap(), 1);
        assert_eq!(get_element(&c, ex).unwrap().parent_id, None);
    }

    #[test]
    fn priority_is_a_position_in_one_queue() {
        let c = db::open_in_memory().unwrap();
        let a = import(&c, "a", 50.0, 100);
        let b = import(&c, "b", 0.0, 100); // to the front
        let d = import(&c, "d", 100.0, 100); // to the back
        let order = |c: &Connection| -> Vec<i64> {
            c.prepare("SELECT id FROM element WHERE status='active' ORDER BY prank").unwrap().query_map([], |r| r.get(0)).unwrap().map(|x| x.unwrap()).collect()
        };
        assert_eq!(order(&c), vec![b, a, d]);
        assert_eq!([priority_of(&c, b).unwrap(), priority_of(&c, a).unwrap(), priority_of(&c, d).unwrap()], [0.0, 50.0, 100.0]);
        // An extract goes right after its parent; percentiles spread over 4.
        let ex = create_extract(&c, b, "", &doc("x"), 100).unwrap();
        assert_eq!(order(&c), vec![b, ex, a, d]);
        assert!((priority_of(&c, a).unwrap() - 200.0 / 3.0).abs() < 1e-3);
        // Setting a percentile moves the element there.
        set_priority(&c, d, 0.0).unwrap();
        assert_eq!(order(&c)[0], d);
        set_priority(&c, d, 60.0).unwrap();
        assert_eq!(order(&c), vec![b, ex, d, a]);
        assert_eq!(queue_rank(&c, d).unwrap(), (3, 4));
        // Several at once stay together in their order.
        set_priority_many(&c, &[a, b], 0.0).unwrap();
        assert_eq!(&order(&c)[..2], &[a, b]);
        // Dismissed elements leave the queue; the rest re-spread.
        dismiss(&c, ex, 100).unwrap();
        assert_eq!(priority_of(&c, *order(&c).last().unwrap()).unwrap(), 100.0);
        // Inbox keeps the requested value until accepted.
        let inb = import_topic(&c, &ImportInput { title: "n".into(), doc_json: doc("n"), priority: 30.0, inbox: true, ..Default::default() }, 100).unwrap();
        assert_eq!(priority_of(&c, inb).unwrap(), 30.0);
        accept(&c, inb, 0.0, 100).unwrap();
        assert_eq!(order(&c)[0], inb);
        assert!(!priority_anchors(&c).unwrap().is_empty());
    }

    #[test]
    fn undo_restores_deleted_done_and_moved_elements() {
        let c = db::open_in_memory().unwrap();
        let src = import(&c, "Article", 50.0, 100);
        let ex = create_extract(&c, src, "", &doc("child"), 100).unwrap();
        let folder = create_topic(&c, None, "Folder", EMPTY_DOC, 100).unwrap();

        // Delete (children move up) → undo brings the element and the link back.
        let snap = snapshot(&c, &with_children(&c, &[src]).unwrap()).unwrap();
        delete_element(&c, src).unwrap();
        assert_eq!(get_element(&c, ex).unwrap().parent_id, None);
        restore_snapshot(&c, &snap).unwrap();
        assert_eq!(get_element(&c, ex).unwrap().parent_id, Some(src));
        assert_eq!(get_element(&c, src).unwrap().reference.unwrap().url.as_deref(), Some("https://example.org"));
        assert_eq!(search(&c, "Article", 10).unwrap(), vec![src]);

        // Done! (text archived) → undo brings the text back and clears the archive.
        let snap = snapshot(&c, &[src]).unwrap();
        done(&c, src, 100).unwrap();
        restore_snapshot(&c, &snap).unwrap();
        let el = get_element(&c, src).unwrap();
        assert_eq!((el.status.as_str(), el.topic.as_ref().unwrap().archived), ("active", false));
        assert_eq!(doc_text(&el.topic.unwrap().doc_json), "Article body text");

        // Move → undo puts it back under its old parent.
        let snap = snapshot(&c, &[ex]).unwrap();
        place(&c, &[ex], Some(folder), None).unwrap();
        restore_snapshot(&c, &snap).unwrap();
        assert_eq!(get_element(&c, ex).unwrap().parent_id, Some(src));
    }

    #[test]
    fn manual_order_and_reordering() {
        let c = db::open_in_memory().unwrap();
        let root = create_topic(&c, None, "Root", EMPTY_DOC, 100).unwrap();
        let a = create_topic(&c, Some(root), "a", EMPTY_DOC, 100).unwrap();
        let b = create_topic(&c, Some(root), "b", EMPTY_DOC, 100).unwrap();
        let d = create_topic(&c, Some(root), "d", EMPTY_DOC, 100).unwrap();
        let loose = create_topic(&c, None, "loose", EMPTY_DOC, 100).unwrap();
        let kids = |c: &Connection| siblings(c, Some(root)).unwrap();
        assert_eq!(kids(&c), vec![a, b, d]);
        place(&c, &[d], Some(root), Some(a)).unwrap();
        assert_eq!(kids(&c), vec![d, a, b]);
        place(&c, &[loose], Some(root), Some(b)).unwrap();
        assert_eq!(kids(&c), vec![d, a, loose, b]);
        place(&c, &[d, a], Some(root), None).unwrap();
        assert_eq!(kids(&c), vec![loose, b, d, a]);
        shift(&c, a, -1).unwrap();
        assert_eq!(kids(&c), vec![loose, b, a, d]);
        shift(&c, loose, -1).unwrap();
        assert_eq!(kids(&c), vec![loose, b, a, d]);
        set_priority(&c, d, 1.0).unwrap();
        sort_children_by_priority(&c, Some(root)).unwrap();
        assert_eq!(kids(&c)[0], d);
        let order: Vec<i64> = tree(&c).unwrap().into_iter().filter(|n| n.parent_id == Some(root)).map(|n| n.id).collect();
        assert_eq!(order, kids(&c));
        assert!(place(&c, &[root], Some(a), None).is_err());
    }

    #[test]
    fn empty_topics_stay_out_of_the_queue() {
        let c = db::open_in_memory().unwrap();
        let folder = create_topic(&c, None, "", r#"{"type":"doc","content":[{"type":"paragraph"}]}"#, 100).unwrap();
        assert_eq!(get_element(&c, folder).unwrap().title, "New topic");
        assert!(queue(&c, 105).unwrap().entries.is_empty());
        assert!(tree(&c).unwrap()[0].empty);
        save_topic(&c, folder, &doc("now it has a note"), None).unwrap();
        assert_eq!(queue(&c, 105).unwrap().entries.len(), 1);
    }

    #[test]
    fn bulk_actions_apply_together() {
        let c = db::open_in_memory().unwrap();
        let a = import(&c, "a", 50.0, 100);
        let b = import(&c, "b", 50.0, 100);
        let x = create_extract(&c, a, "", &doc("x"), 100).unwrap();
        assert_eq!(bulk(&c, &[a, b], "priority", Some(0.0), 100).unwrap(), 2);
        assert_eq!((queue_rank(&c, a).unwrap().0, queue_rank(&c, b).unwrap().0), (1, 2));
        bulk(&c, &[a, b], "dismiss", None, 100).unwrap();
        assert!(queue(&c, 100).unwrap().entries.is_empty());
        bulk(&c, &[a, b], "restore", None, 100).unwrap();
        assert_eq!(queue(&c, 100).unwrap().entries.len(), 2);
        assert!(bulk(&c, &[a], "nonsense", None, 100).is_err());
        bulk(&c, &[a, x], "delete", None, 100).unwrap();
        assert_eq!(tree(&c).unwrap().len(), 1);
        let qs = branches_queue(&c, &[b, b], false, 100).unwrap();
        assert_eq!(qs.len(), 1);
    }

    #[test]
    fn retention_follows_priority() {
        let s = Settings::default();
        assert!((s.retention_for(0.0) - s.retention_top).abs() < 1e-9);
        assert!((s.retention_for(100.0) - s.retention_bottom).abs() < 1e-9);
        assert!(s.retention_for(50.0) < s.retention_top && s.retention_for(50.0) > s.retention_bottom);
        // Higher retention means shorter intervals.
        let c = db::open_in_memory().unwrap();
        let f = fsrs();
        let t = import(&c, "src", 50.0, 100);
        let hi = item(&c, t, "hi", 100);
        let lo = item(&c, t, "lo", 100);
        set_priority(&c, hi, 0.0).unwrap();
        set_priority(&c, lo, 100.0).unwrap();
        grade_item(&c, &f, hi, 3, 101).unwrap();
        grade_item(&c, &f, lo, 3, 101).unwrap();
        let ih = grade_item(&c, &f, hi, 3, 110).unwrap();
        let il = grade_item(&c, &f, lo, 3, 110).unwrap();
        assert!(ih < il, "important {ih} vs unimportant {il}");
    }

    #[test]
    fn training_set_and_stats() {
        let c = db::open_in_memory().unwrap();
        let f = fsrs();
        let t = import(&c, "src", 50.0, 100);
        let i = item(&c, t, "q", 100);
        grade_item(&c, &f, i, 3, 101).unwrap();
        grade_item(&c, &f, i, 3, 104).unwrap();
        grade_item(&c, &f, i, 1, 110).unwrap();
        let (items, ids) = training_set(&c).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(ids, vec![i, i]);
        assert_eq!(items[1].reviews.iter().map(|r| (r.rating, r.delta_t)).collect::<Vec<_>>(), vec![(3, 0), (3, 3), (1, 6)]);
        assert!(fit_parameters(training_data(&c).unwrap()).is_err(), "too little history");
        let s = full_stats(&c, 110).unwrap();
        assert_eq!(s.history.len(), 30);
        assert_eq!(s.history.last().unwrap().again, 1);
        assert_eq!(s.mature_reviews, 2);
        assert_eq!(s.true_retention, Some(0.5));
        assert_eq!(s.forecast_items.len(), 30);
        assert_eq!(s.forecast_items[0], 1);
        assert_eq!(s.sources[0].items, 1);
    }

    #[test]
    fn pdf_topics_queue_and_marks() {
        let c = db::open_in_memory().unwrap();
        let id = import_pdf(&c, &PdfImport { title: "Paper".into(), asset: "abc.pdf".into(), priority: 30.0, url: None, author: None, parent: None, inbox: false }, 100).unwrap();
        assert_eq!(queue(&c, 100).unwrap().entries.len(), 1);
        set_pdf_page(&c, id, 7).unwrap();
        let ex = create_extract(&c, id, "", &doc("from page 7"), 100).unwrap();
        add_pdf_mark(&c, id, Some(ex), 7, &[[0.1, 0.2, 0.5, 0.05]], "extract").unwrap();
        let marks = pdf_marks(&c, id).unwrap();
        assert_eq!((marks.len(), marks[0].page, marks[0].child_id), (1, 7, Some(ex)));
        let t = get_element(&c, id).unwrap().topic.unwrap();
        assert_eq!((t.pdf_asset.as_deref(), t.pdf_page), (Some("abc.pdf"), Some(7)));
        delete_element(&c, ex).unwrap();
        assert!(pdf_marks(&c, id).unwrap().is_empty());
    }

    #[test]
    fn migration_from_v1_converts_items_to_documents() {
        let dir = std::env::temp_dir().join(format!("ir-mig-{}-{}", std::process::id(), now_ts()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("c.sqlite");
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch(&format!("{} PRAGMA user_version = 1;", db::SCHEMA_V1)).unwrap();
            c.execute_batch(
                "INSERT INTO element (id, kind, title, priority, status, created_at, updated_at) VALUES (1,'item','q',50,'active',0,0);
                 INSERT INTO item (element_id, question, answer, due_day) VALUES (1, 'Leptin is made by [...]', '', 5);",
            )
            .unwrap();
        }
        let (c, from) = db::open(&path).unwrap();
        assert_eq!(from, 1);
        let it = get_element(&c, 1).unwrap().item.unwrap();
        assert_eq!(doc_text(&it.question), "Leptin is made by [...]");
        assert_eq!(doc_text(&it.answer), "");
        assert!(serde_json::from_str::<Value>(&it.answer).is_ok());
        assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), db::LATEST);
        drop(c);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn flags_breadcrumbs_and_export() {
        let c = db::open_in_memory().unwrap();
        let src = import(&c, "Biology", 10.0, 100);
        let ex = create_extract(&c, src, "Cells", &doc("Cells are small."), 100).unwrap();
        let it = item(&c, ex, "Cells are [...]", 100);
        let crumbs: Vec<i64> = get_element(&c, it).unwrap().ancestors.iter().map(|a| a.id).collect();
        assert_eq!(crumbs, vec![src, ex]);

        set_flag(&c, src, "pinned", true).unwrap();
        set_flag(&c, it, "needs_work", true).unwrap();
        assert!(set_flag(&c, it, "bogus", true).is_err());
        let t = tree(&c).unwrap();
        assert!(t.iter().find(|n| n.id == src).unwrap().pinned);
        assert!(t.iter().find(|n| n.id == it).unwrap().needs_work);
        assert!(get_element(&c, it).unwrap().needs_work);

        let all = export_items(&c, None).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].deck, "Biology");
        assert!(all[0].reference.as_deref().unwrap().contains("example.org"));
        let other = import(&c, "Other", 50.0, 100);
        assert!(export_items(&c, Some(&[other])).unwrap().is_empty());
        assert_eq!(export_items(&c, Some(&[ex])).unwrap().len(), 1);
    }

    #[test]
    fn session_summary_counts_log() {
        let c = db::open_in_memory().unwrap();
        let f = fsrs();
        let since = now_ts();
        let src = import(&c, "A", 10.0, 100);
        let ex = create_extract(&c, src, "", &doc("x"), 100).unwrap();
        let it = item(&c, ex, "q [...]", 100);
        topic_read(&c, src, 100).unwrap();
        grade_item(&c, &f, it, 1, 101).unwrap();
        grade_item(&c, &f, it, 3, 101).unwrap();
        reschedule(&c, ex, 3, 101).unwrap();
        let s = session_summary(&c, since).unwrap();
        assert_eq!(
            s,
            SessionSummary { topics_read: 1, items_graded: 2, items_again: 1, extracts: 1, items_created: 1, postponed: 1, done: 0 }
        );
        assert_eq!(session_summary(&c, since + 10_000).unwrap(), SessionSummary::default());
    }

    #[test]
    fn video_topics_and_clips() {
        let c = db::open_in_memory().unwrap();
        // No transcript: still in the queue, like a PDF.
        let v = import_topic(
            &c,
            &ImportInput { title: "Talk".into(), doc_json: EMPTY_DOC.into(), priority: 20.0, video_id: Some("abcdefghijk".into()), ..Default::default() },
            100,
        )
        .unwrap();
        assert_eq!(queue(&c, 100).unwrap().entries.iter().filter(|q| q.id == v).count(), 1);
        set_video_pos(&c, v, 61.5).unwrap();
        assert_eq!(get_element(&c, v).unwrap().topic.unwrap().video_pos, Some(61.5));
        assert!(create_clip(&c, v, "", 30.0, 10.0, EMPTY_DOC, 100).is_err());
        let clip = create_clip(&c, v, "Key point", 30.0, 45.0, EMPTY_DOC, 100).unwrap();
        let t = get_element(&c, clip).unwrap().topic.unwrap();
        assert_eq!((t.video_id.as_deref(), t.video_start, t.video_end, t.video_pos), (Some("abcdefghijk"), Some(30.0), Some(45.0), Some(30.0)));
        assert!(t.text_len > 0);
        assert!(tree(&c).unwrap().iter().find(|n| n.id == clip).unwrap().video);
        let plain = import(&c, "Plain", 50.0, 100);
        assert!(create_clip(&c, plain, "", 0.0, 5.0, EMPTY_DOC, 100).is_err());
    }

    #[test]
    fn browse_rows_describe_elements() {
        let c = db::open_in_memory().unwrap();
        let src = import(&c, "Src", 10.0, 100);
        topic_read(&c, src, 100).unwrap();
        let it = item(&c, src, "q [...]", 100);
        let rows = browse_rows(&c, 100).unwrap();
        let s = rows.iter().find(|r| r.id == src).unwrap();
        assert_eq!((s.subtype.as_str(), s.reps, s.children), ("text", 1, 1));
        let i = rows.iter().find(|r| r.id == it).unwrap();
        assert_eq!((i.subtype.as_str(), i.parent_id), ("cloze", Some(src)));
        set_afactor(&c, src, 9.0).unwrap();
        assert_eq!(get_element(&c, src).unwrap().topic.unwrap().afactor, 5.0);
        assert!(set_afactor(&c, it, 2.0).is_err());
        assert_eq!(browse_rows(&c, 100).unwrap().iter().find(|r| r.id == src).unwrap().afactor, Some(5.0));
        // Queue order: the child follows its parent.
        assert!(rows.iter().position(|r| r.id == src) < rows.iter().position(|r| r.id == it));
    }

    #[test]
    fn tags_cram_siblings_and_helpers() {
        let c = db::open_in_memory().unwrap();
        let f = fsrs();
        let src = import(&c, "Heart", 10.0, 100);
        let a = item(&c, src, "a [...]", 100);
        let b = item(&c, src, "b [...]", 100);
        // Siblings: only one per parent in today's queue; a subset review shows both.
        let q: Vec<i64> = queue(&c, 101).unwrap().entries.iter().filter(|e| e.kind == "item").map(|e| e.id).collect();
        assert_eq!(q.len(), 1);
        assert_eq!(branches_queue(&c, &[src], true, 101).unwrap().iter().filter(|e| e.kind == "item").count(), 2);

        set_tags(&c, a, &["cardio".into(), "#exam".into()]).unwrap();
        assert_eq!(tags_of(&c, a).unwrap(), vec!["cardio", "exam"]);
        tag_many(&c, &[a, b], "exam", false).unwrap();
        assert_eq!(tags_of(&c, a).unwrap(), vec!["cardio"]);
        assert_eq!(all_tags(&c).unwrap(), vec![("cardio".to_string(), 1)]);
        assert_eq!(browse_rows(&c, 101).unwrap().iter().find(|r| r.id == a).unwrap().tags, vec!["cardio"]);

        // Cram raises the target retention inside the branch only, until the date.
        set_cram(&c, &[Cram { root: src, title: "Heart".into(), retention: 0.97, until: 110 }], 101).unwrap();
        assert_eq!(cram_retention(&c, a, 105).unwrap(), 0.97);
        assert_eq!(cram_retention(&c, a, 111).unwrap(), 0.0);
        let normal = preview_item(&c, &f, a, 101).unwrap();
        grade_item(&c, &f, a, 3, 101).unwrap();
        set_last_duration(&c, a, 4200).unwrap();
        let d: i64 = c.query_row("SELECT duration_ms FROM review_log WHERE element_id=?1 AND kind='grade'", [a], |r| r.get(0)).unwrap();
        assert_eq!(d, 4200);
        assert!(normal[2] >= 1);
        let row = browse_rows(&c, 104).unwrap().into_iter().find(|r| r.id == a).unwrap();
        let r = row.retrievability.unwrap();
        assert!(r > 0.0 && r < 1.0);

        // Continue reading and the priority audit.
        save_topic(&c, src, &doc("Heart body text that is long enough"), Some(5)).unwrap();
        assert_eq!(continue_reading(&c, 10).unwrap().iter().map(|s| s.id).collect::<Vec<_>>(), vec![src]);
        assert!(priority_audit(&c, 101).unwrap().is_empty());
        // Test days are small numbers; make the creation time match them.
        c.execute("UPDATE element SET created_at = 100 * 86400", []).unwrap();
        let late = priority_audit(&c, 400).unwrap();
        assert_eq!(late.iter().map(|x| x.id).collect::<Vec<_>>(), vec![src]);
        mark_audited(&c, src, 400).unwrap();
        assert!(priority_audit(&c, 401).unwrap().is_empty());
        let st = full_stats(&c, 101).unwrap();
        assert_eq!(st.seconds_per_review, Some(4.2));
        assert_eq!(st.retention_by_band.len(), 4);
    }

    #[test]
    fn front_load_pulls_upcoming_work_forward() {
        let c = db::open_in_memory().unwrap();
        let a = import(&c, "a", 10.0, 100);
        let b = import(&c, "b", 20.0, 100);
        reschedule(&c, a, 5, 100).unwrap();
        reschedule(&c, b, 9, 100).unwrap();
        assert_eq!(front_load(&c, None, 7, 2, true, 100).unwrap(), vec![1, 0]);
        assert_eq!(upcoming_ids(&c, None, 7, 100).unwrap(), vec![a]);
        front_load(&c, None, 10, 2, false, 100).unwrap();
        let due = |id| get_element(&c, id).unwrap().topic.unwrap().due_day;
        // Most important first: it gets the earlier day.
        let (first, second) = if priority_of(&c, a).unwrap() < priority_of(&c, b).unwrap() { (a, b) } else { (b, a) };
        assert_eq!((due(first), due(second)), (100, 101));
    }

    #[test]
    fn append_lines_to_topic() {
        let c = db::open_in_memory().unwrap();
        let t = create_topic(&c, None, "VN", EMPTY_DOC, 100).unwrap();
        append_lines(&c, t, &["「おはよう」".into(), "  ".into()], Some("Session 1")).unwrap();
        let n = append_lines(&c, t, &["二行目".into()], None).unwrap();
        let doc: Value = serde_json::from_str(&get_element(&c, t).unwrap().topic.unwrap().doc_json).unwrap();
        let kinds: Vec<&str> = doc["content"].as_array().unwrap().iter().map(|n| n["type"].as_str().unwrap()).collect();
        assert_eq!(kinds, vec!["heading", "paragraph", "paragraph"]);
        assert!(n > 0);
        // It now has text, so it can come up in the queue like any article.
        assert!(tree(&c).unwrap().iter().any(|n| n.id == t && !n.empty));
    }
}
