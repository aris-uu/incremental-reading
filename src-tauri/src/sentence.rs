//! Sentence cards for language learning (sentence mining).
//!
//! A sentence item keeps its fields as a JSON object, using the field names of
//! the Senren note type for Anki, so an existing Yomitan setup for Senren works
//! unchanged through the AnkiConnect-compatible server. The item's question and
//! answer documents are kept in step as plain versions (the sentence with the
//! target word in bold; the word, reading and a plain gloss) for search,
//! titles and export.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use crate::engine::{self, Result};

fn e<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

/// Senren's fields, in order. The first one ("word") is the duplicate key.
pub const FIELDS: &[&str] = &[
    "word",
    "reading",
    "sentence",
    "sentenceFurigana",
    "sentenceTranslation",
    "sentenceCard",
    "audioCard",
    "notes",
    "selectionText",
    "definition",
    "wordAudio",
    "sentenceAudio",
    "picture",
    "glossary",
    "pitchAccents",
    "pitchPositions",
    "pitchCategories",
    "frequencies",
    "freqSort",
    "miscInfo",
    "dictionaryPreference",
];

/// Note type names offered to Yomitan; both have the fields above.
pub const MODELS: &[&str] = &["Senren", "IR Sentence"];

/// Plain text of an HTML fragment: tags removed, common entities decoded.
pub fn html_to_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut tag = String::new();
    for c in html.chars() {
        match c {
            '<' => {
                in_tag = true;
                tag.clear();
            }
            '>' if in_tag => {
                in_tag = false;
                let t = tag.trim_start_matches('/').split_whitespace().next().unwrap_or("").to_ascii_lowercase();
                if matches!(t.as_str(), "br" | "li" | "p" | "div" | "tr") && !out.ends_with('\n') && !out.is_empty() {
                    out.push('\n');
                }
            }
            _ if in_tag => tag.push(c),
            _ => out.push(c),
        }
    }
    let out = out.replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&");
    // Anki media references aren't text.
    let mut cleaned = String::new();
    let mut rest = out.as_str();
    while let Some(i) = rest.find("[sound:") {
        cleaned.push_str(&rest[..i]);
        rest = rest[i..].find(']').map_or("", |j| &rest[i + j + 1..]);
    }
    cleaned.push_str(rest);
    cleaned.lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n")
}

/// The sentence split around the target word, which Yomitan marks with
/// `<b>` or `<span class="highlight">` (Senren accepts both).
pub fn split_target(sentence_html: &str) -> (String, String, String) {
    let lower = sentence_html.to_ascii_lowercase();
    let open = ["<b>", "<span class=\"highlight\">", "<span class='highlight'>", "<strong>"].iter().find_map(|t| lower.find(t).map(|i| (i, t.len())));
    if let Some((i, len)) = open {
        let after = &sentence_html[i + len..];
        let close = ["</b>", "</span>", "</strong>"].iter().filter_map(|t| after.to_ascii_lowercase().find(t)).min();
        if let Some(j) = close {
            return (html_to_text(&sentence_html[..i]), html_to_text(&after[..j]), html_to_text(&after[j..]));
        }
    }
    (html_to_text(sentence_html), String::new(), String::new())
}

fn get<'a>(f: &'a Map<String, Value>, k: &str) -> &'a str {
    f.get(k).and_then(Value::as_str).unwrap_or("")
}

/// Question and answer documents (ProseMirror JSON) mirroring the fields.
pub fn docs(fields: &Map<String, Value>) -> (String, String) {
    let (pre, target, post) = split_target(get(fields, "sentence"));
    let target = if target.is_empty() && pre.is_empty() { get(fields, "word").to_string() } else { target };
    let text = |t: &str| json!({ "type": "text", "text": t });
    let mut q = Vec::new();
    if !pre.is_empty() {
        q.push(text(&pre));
    }
    if !target.is_empty() {
        q.push(json!({ "type": "text", "text": target, "marks": [{ "type": "bold" }] }));
    }
    if !post.is_empty() {
        q.push(text(&post));
    }
    let para = |content: Vec<Value>| if content.is_empty() { json!({ "type": "paragraph" }) } else { json!({ "type": "paragraph", "content": content }) };
    let word = get(fields, "word");
    let reading = get(fields, "reading");
    let head = if reading.is_empty() || reading == word { word.to_string() } else { format!("{word}【{reading}】") };
    let gloss_src = if get(fields, "selectionText").is_empty() {
        if get(fields, "definition").is_empty() { get(fields, "glossary") } else { get(fields, "definition") }
    } else {
        get(fields, "selectionText")
    };
    let gloss: String = html_to_text(gloss_src).chars().take(400).collect();
    let mut a = vec![para(if head.is_empty() { vec![] } else { vec![text(&head)] })];
    if !gloss.is_empty() {
        a.push(para(vec![text(&gloss)]));
    }
    (json!({ "type": "doc", "content": [para(q)] }).to_string(), json!({ "type": "doc", "content": a }).to_string())
}

/// Frequency rank → priority: the most frequent words go to the head of the queue.
pub fn priority_from_freq(freq_sort: &str) -> Option<f64> {
    let rank: f64 = freq_sort.trim().parse().ok().filter(|r: &f64| *r > 0.0 && *r < 9_999_999.0)?;
    Some(((rank.ln() / 60_000f64.ln()) * 100.0).clamp(1.0, 99.0))
}

fn normalized(fields: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for k in FIELDS {
        out.insert((*k).to_string(), Value::String(get(fields, k).to_string()));
    }
    // Unknown field names from other note types are kept as they are.
    for (k, v) in fields {
        if !out.contains_key(k) {
            out.insert(k.clone(), Value::String(v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())));
        }
    }
    out
}

fn title_for(fields: &Map<String, Value>) -> String {
    let (pre, target, post) = split_target(get(fields, "sentence"));
    let word = if get(fields, "word").is_empty() { target.clone() } else { get(fields, "word").to_string() };
    let sentence: String = format!("{pre}{target}{post}").chars().take(50).collect();
    match (word.is_empty(), sentence.is_empty()) {
        (false, false) => format!("{word} — {sentence}"),
        (false, true) => word,
        (true, false) => sentence,
        _ => "Sentence".into(),
    }
}

/// New sentence item. Priority: given, else from the frequency rank, else 50%
/// (or right after the parent when there is one).
pub fn create(conn: &Connection, parent: Option<i64>, fields: &Map<String, Value>, tags: &[String], priority: Option<f64>, day: i64) -> Result<i64> {
    let fields = normalized(fields);
    let (q, a) = docs(&fields);
    let id = engine::create_item(conn, parent, "sentence", &q, &a, day)?;
    conn.execute("UPDATE item SET fields_json=?2 WHERE element_id=?1", params![id, Value::Object(fields.clone()).to_string()]).map_err(e)?;
    engine::set_title(conn, id, &title_for(&fields))?;
    if let Some(p) = priority.or_else(|| priority_from_freq(get(&fields, "freqSort"))) {
        engine::set_priority(conn, id, p)?;
    }
    if !tags.is_empty() {
        engine::set_tags(conn, id, tags)?;
    }
    Ok(id)
}

pub fn fields_of(conn: &Connection, id: i64) -> Result<Option<Map<String, Value>>> {
    let raw: Option<Option<String>> = conn.query_row("SELECT fields_json FROM item WHERE element_id=?1", [id], |r| r.get(0)).optional().map_err(e)?;
    Ok(raw.flatten().and_then(|s| serde_json::from_str::<Value>(&s).ok()).and_then(|v| v.as_object().cloned()))
}

/// Merge field values into a sentence item and refresh its documents.
pub fn update(conn: &Connection, id: i64, patch: &Map<String, Value>) -> Result<()> {
    let mut fields = fields_of(conn, id)?.ok_or("Not a sentence item")?;
    for (k, v) in patch {
        fields.insert(k.clone(), Value::String(v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())));
    }
    let (q, a) = docs(&fields);
    conn.execute("UPDATE item SET fields_json=?2 WHERE element_id=?1", params![id, Value::Object(fields.clone()).to_string()]).map_err(e)?;
    engine::save_item(conn, id, &q, &a)?;
    engine::set_title(conn, id, &title_for(&fields))
}

/// Topic for an Anki deck path ("Japanese::Mining"): top-level topics by
/// title, created as empty folders when missing. "Default" means no parent.
pub fn ensure_deck(conn: &Connection, deck: &str, day: i64) -> Result<Option<i64>> {
    let deck = deck.trim();
    if deck.is_empty() || deck == "Default" {
        return Ok(None);
    }
    let mut parent: Option<i64> = None;
    for part in deck.split("::").map(str::trim).filter(|p| !p.is_empty()) {
        let found: Option<i64> = conn
            .query_row(
                "SELECT e.id FROM element e JOIN topic t ON t.element_id = e.id WHERE e.parent_id IS ?1 AND e.title = ?2 AND e.status != 'dismissed' ORDER BY e.id LIMIT 1",
                params![parent, part],
                |r| r.get(0),
            )
            .optional()
            .map_err(e)?;
        parent = Some(match found {
            Some(id) => id,
            None => engine::create_topic(conn, parent, part, engine::EMPTY_DOC, day)?,
        });
    }
    Ok(parent)
}

/// Deck path of an element: its ancestors' titles (or "Default" at the top).
pub fn deck_of(conn: &Connection, id: i64) -> Result<String> {
    let a = engine::ancestors(conn, id)?;
    Ok(if a.is_empty() { "Default".into() } else { a.into_iter().map(|c| c.title).collect::<Vec<_>>().join("::") })
}

/// All sentence items: (id, fields, created_at, parent).
pub fn all(conn: &Connection) -> Result<Vec<(i64, Map<String, Value>, i64)>> {
    let mut stmt = conn
        .prepare("SELECT e.id, i.fields_json, e.created_at FROM element e JOIN item i ON i.element_id = e.id WHERE i.item_type = 'sentence' AND i.fields_json IS NOT NULL ORDER BY e.id")
        .map_err(e)?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))
        .map_err(e)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(e)?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, f, ts)| serde_json::from_str::<Value>(&f).ok().and_then(|v| v.as_object().cloned()).map(|m| (id, m, ts)))
        .collect())
}

/// Is there already a sentence item with this word (the first field)?
pub fn duplicate_of(conn: &Connection, word: &str) -> Result<Option<i64>> {
    let w = html_to_text(word);
    if w.is_empty() {
        return Ok(None);
    }
    Ok(all(conn)?.into_iter().find(|(_, f, _)| html_to_text(get(f, "word")) == w).map(|(id, _, _)| id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn f(pairs: &[(&str, &str)]) -> Map<String, Value> {
        pairs.iter().map(|(k, v)| (k.to_string(), Value::String(v.to_string()))).collect()
    }

    #[test]
    fn target_word_and_docs() {
        assert_eq!(split_target("彼は<b>食べた</b>。"), ("彼は".into(), "食べた".into(), "。".into()));
        assert_eq!(
            split_target(r#"<span class="group">猫が<span class="highlight">好き</span>だ</span>"#),
            ("猫が".into(), "好き".into(), "だ".into())
        );
        let (q, a) = docs(&f(&[("word", "食べる"), ("reading", "たべる"), ("sentence", "彼は<b>食べた</b>。"), ("glossary", "<ul><li>to eat</li></ul>")]));
        let qv: Value = serde_json::from_str(&q).unwrap();
        let target = &qv["content"][0]["content"][1];
        assert_eq!((target["text"].as_str(), target["marks"][0]["type"].as_str()), (Some("食べた"), Some("bold")), "{q}");
        assert!(a.contains("食べる【たべる】") && a.contains("to eat"), "{a}");
        assert_eq!(html_to_text("a<br>b [sound:x.mp3] &amp; c"), "a\nb  & c");
    }

    #[test]
    fn frequency_sets_priority() {
        assert!(priority_from_freq("100").unwrap() < priority_from_freq("20000").unwrap());
        assert_eq!(priority_from_freq(""), None);
        assert_eq!(priority_from_freq("9999999"), None);
    }

    #[test]
    fn create_update_decks_and_duplicates() {
        let c = db::open_in_memory().unwrap();
        let deck = ensure_deck(&c, "Japanese::Mining", 100).unwrap().unwrap();
        assert_eq!(ensure_deck(&c, "Japanese::Mining", 100).unwrap(), Some(deck));
        assert_eq!(ensure_deck(&c, "Default", 100).unwrap(), None);
        let id = create(&c, Some(deck), &f(&[("word", "猫"), ("sentence", "<b>猫</b>がいる"), ("freqSort", "300")]), &["mined".into()], None, 100).unwrap();
        assert_eq!(deck_of(&c, id).unwrap(), "Japanese::Mining");
        assert_eq!(duplicate_of(&c, "猫").unwrap(), Some(id));
        assert_eq!(duplicate_of(&c, "犬").unwrap(), None);
        let el = engine::get_element(&c, id).unwrap();
        assert_eq!(el.item.unwrap().item_type, "sentence");
        assert!(el.title.starts_with("猫 — 猫がいる"));
        assert_eq!(el.tags, vec!["mined"]);
        update(&c, id, &f(&[("picture", "<img src=\"a.png\">")])).unwrap();
        assert_eq!(fields_of(&c, id).unwrap().unwrap()["picture"], "<img src=\"a.png\">");
        assert_eq!(fields_of(&c, id).unwrap().unwrap()["word"], "猫");
    }
}
