use rusqlite::Connection;

/// Schema version 1: elements, topics, items, references, review log.
pub(crate) const SCHEMA_V1: &str = r#"
CREATE TABLE element (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('topic','item')),
  parent_id   INTEGER REFERENCES element(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  priority    REAL NOT NULL DEFAULT 50,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','dismissed')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX element_parent ON element(parent_id);

CREATE TABLE topic (
  element_id    INTEGER PRIMARY KEY REFERENCES element(id) ON DELETE CASCADE,
  doc_json      TEXT NOT NULL,
  read_point    INTEGER,
  afactor       REAL NOT NULL,
  interval_days INTEGER NOT NULL DEFAULT 0,
  due_day       INTEGER NOT NULL,
  last_day      INTEGER
);
CREATE INDEX topic_due ON topic(due_day);

CREATE TABLE item (
  element_id    INTEGER PRIMARY KEY REFERENCES element(id) ON DELETE CASCADE,
  item_type     TEXT NOT NULL DEFAULT 'cloze',
  question      TEXT NOT NULL,
  answer        TEXT NOT NULL,
  context       TEXT NOT NULL DEFAULT '',
  stability     REAL,
  difficulty    REAL,
  interval_days INTEGER NOT NULL DEFAULT 0,
  due_day       INTEGER NOT NULL,
  last_day      INTEGER,
  reps          INTEGER NOT NULL DEFAULT 0,
  lapses        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX item_due ON item(due_day);

CREATE TABLE source_ref (
  element_id  INTEGER PRIMARY KEY REFERENCES element(id) ON DELETE CASCADE,
  url         TEXT,
  author      TEXT,
  site        TEXT,
  accessed_at INTEGER
);

CREATE TABLE review_log (
  id             INTEGER PRIMARY KEY,
  element_id     INTEGER NOT NULL,
  ts             INTEGER NOT NULL,
  day            INTEGER NOT NULL,
  kind           TEXT NOT NULL,
  grade          INTEGER,
  elapsed_days   INTEGER,
  interval_after INTEGER,
  stability      REAL,
  difficulty     REAL
);
CREATE INDEX review_log_element ON review_log(element_id);
"#;

/// Wrap a plain-text column value in a one-paragraph ProseMirror document.
fn text_to_doc_sql(col: &str) -> String {
    format!(
        "json_object('type','doc','content', json_array(CASE WHEN {col} = '' THEN json_object('type','paragraph')
           ELSE json_object('type','paragraph','content', json_array(json_object('type','text','text',{col}))) END))"
    )
}

/// Schema version 2:
/// - `inbox` status for untriaged imports (rebuilds `element` for the CHECK)
/// - item question/answer become rich-text ProseMirror documents
/// - archive of text removed by Done!, settings, full-text search
fn schema_v2() -> String {
    format!(
        r#"
CREATE TABLE element_new (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('topic','item')),
  parent_id   INTEGER REFERENCES element(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  priority    REAL NOT NULL DEFAULT 50,          -- 0 = most important, 100 = least
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('inbox','active','done','dismissed')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
INSERT INTO element_new SELECT * FROM element;
DROP TABLE element;
ALTER TABLE element_new RENAME TO element;
CREATE INDEX element_parent ON element(parent_id);
CREATE INDEX element_status ON element(status);

UPDATE item SET question = {q}, answer = {a};

CREATE TABLE topic_archive (
  id          INTEGER PRIMARY KEY,
  element_id  INTEGER NOT NULL REFERENCES element(id) ON DELETE CASCADE,
  doc_json    TEXT NOT NULL,
  ts          INTEGER NOT NULL
);
CREATE INDEX topic_archive_element ON topic_archive(element_id);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE VIRTUAL TABLE search USING fts5(element_id UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');
"#,
        q = text_to_doc_sql("question"),
        a = text_to_doc_sql("answer"),
    )
}

/// Schema version 3:
/// - `topic.text_len`: cached text length, so empty topics (notes, folders,
///   finished articles) stay out of the queue
/// - PDF topics: the file lives in assets, the read point is a page
/// - marks drawn on PDF pages for extracted regions
const SCHEMA_V3: &str = r#"
ALTER TABLE topic ADD COLUMN text_len INTEGER NOT NULL DEFAULT 0;
ALTER TABLE topic ADD COLUMN pdf_asset TEXT;
ALTER TABLE topic ADD COLUMN pdf_page INTEGER;
-- Title of the original source, kept when an element's reference is pinned (moved away from it).
ALTER TABLE source_ref ADD COLUMN title TEXT;
CREATE TABLE pdf_mark (
  id          INTEGER PRIMARY KEY,
  element_id  INTEGER NOT NULL REFERENCES element(id) ON DELETE CASCADE,
  child_id    INTEGER REFERENCES element(id) ON DELETE CASCADE,
  page        INTEGER NOT NULL,
  rects_json  TEXT NOT NULL,                     -- [[x,y,w,h], ...] as fractions of the page
  kind        TEXT NOT NULL DEFAULT 'extract'
);
CREATE INDEX pdf_mark_element ON pdf_mark(element_id);
"#;

/// Schema version 4: manual sibling order in the tree.
const SCHEMA_V4: &str = r#"
ALTER TABLE element ADD COLUMN position REAL NOT NULL DEFAULT 0;
UPDATE element SET position = id;
CREATE INDEX element_position ON element(parent_id, position);
"#;

/// Schema version 5: SuperMemo-style priority. `prank` is the position in one
/// global priority queue; `priority` becomes a cached percentile of that
/// position among active elements (0% = first in the queue).
const SCHEMA_V5: &str = r#"
ALTER TABLE element ADD COLUMN prank REAL NOT NULL DEFAULT 0;
UPDATE element SET prank = (
  SELECT COUNT(*) FROM element e2
  WHERE e2.priority < element.priority OR (e2.priority = element.priority AND e2.id <= element.id)
);
CREATE INDEX element_prank ON element(prank);
"#;

/// Schema version 6: per-element flags and video topics. `pinned` keeps a root at the top of
/// the tree; `needs_work` marks an item to reformulate (it keeps its schedule).
const SCHEMA_V6: &str = r#"
ALTER TABLE element ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE element ADD COLUMN needs_work INTEGER NOT NULL DEFAULT 0;
-- Incremental video: a YouTube video id, a clip range (extracts) and the resume position, in seconds.
ALTER TABLE topic ADD COLUMN video_id TEXT;
ALTER TABLE topic ADD COLUMN video_start REAL;
ALTER TABLE topic ADD COLUMN video_end REAL;
ALTER TABLE topic ADD COLUMN video_pos REAL;
"#;

pub const LATEST: i64 = 6;

pub fn open(path: &std::path::Path) -> rusqlite::Result<(Connection, i64)> {
    let conn = Connection::open(path)?;
    let from = init(&conn)?;
    Ok((conn, from))
}

#[cfg(test)]
pub fn open_in_memory() -> rusqlite::Result<Connection> {
    let conn = Connection::open_in_memory()?;
    init(&conn)?;
    Ok(conn)
}

/// Bring the schema up to date. Returns the version found before migrating.
fn init(conn: &Connection) -> rusqlite::Result<i64> {
    conn.execute_batch("PRAGMA journal_mode = WAL;")?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    // Foreign keys must be off while tables are rebuilt (and can't change inside a transaction).
    conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
    if version < 1 {
        conn.execute_batch(&format!("BEGIN; {SCHEMA_V1} PRAGMA user_version = 1; COMMIT;"))?;
    }
    if version < 2 {
        conn.execute_batch(&format!("BEGIN; {} PRAGMA user_version = 2; COMMIT;", schema_v2()))?;
    }
    if version < 3 {
        conn.execute_batch(&format!("BEGIN; {SCHEMA_V3} PRAGMA user_version = 3; COMMIT;"))?;
    }
    if version < 4 {
        conn.execute_batch(&format!("BEGIN; {SCHEMA_V4} PRAGMA user_version = 4; COMMIT;"))?;
    }
    if version < 5 {
        conn.execute_batch(&format!("BEGIN; {SCHEMA_V5} PRAGMA user_version = 5; COMMIT;"))?;
    }
    if version < 6 {
        conn.execute_batch(&format!("BEGIN; {SCHEMA_V6} PRAGMA user_version = 6; COMMIT;"))?;
    }
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    Ok(version)
}
