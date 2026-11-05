//! AnkiConnect-compatible API, so Yomitan (and mpvacious, ShareX scripts,
//! anything that speaks AnkiConnect) can add sentence cards straight into
//! this collection. Point Yomitan's "AnkiConnect server address" at
//! `http://127.0.0.1:<port>`; decks map to topics, notes to sentence items.
//!
//! Only the actions those tools use are implemented. Responses follow
//! AnkiConnect: for request version ≤ 4 the bare result (errors as
//! `{"result": null, "error": …}`), from version 5 on `{"result", "error"}`.

use std::io::Read;
use std::path::Path;

use rusqlite::Connection;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::{assets, engine, sentence};

pub const DEFAULT_PORT: u16 = 8766;
const MAX_BODY: u64 = 60 * 1024 * 1024;

const ACTIONS: &[&str] = &[
    "version", "requestPermission", "apiReflect", "sync", "multi",
    "deckNames", "deckNamesAndIds", "createDeck", "modelNames", "modelNamesAndIds", "modelFieldNames",
    "findNotes", "findCards", "cardsToNotes", "notesInfo", "cardsInfo",
    "canAddNotes", "canAddNotesWithErrorDetail", "addNote", "addNotes",
    "updateNoteFields", "updateNote", "addTags", "removeTags", "deleteNotes",
    "storeMediaFile", "retrieveMediaFile", "getMediaDirPath",
    "guiBrowse", "guiEditNote", "guiSelectedNotes",
];

/// What the server needs besides the database.
pub struct Ctx<'a> {
    pub assets: &'a Path,
    pub day: i64,
    /// Asks the UI to show elements (guiBrowse, guiEditNote).
    pub show: &'a dyn Fn(Vec<i64>),
}

fn s(v: &Value) -> String {
    v.as_str().map(str::to_string).unwrap_or_default()
}

fn fields_map(v: &Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

fn ids(v: &Value) -> Vec<i64> {
    v.as_array().map(|a| a.iter().filter_map(Value::as_i64).collect()).unwrap_or_default()
}

/// Store a media file under (a sanitized form of) its own name.
fn store_media(dir: &Path, p: &Value) -> Result<String, String> {
    let name = s(&p["filename"]);
    let bytes = if let Some(data) = p["data"].as_str() {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|e| e.to_string())?
    } else if let Some(url) = p["url"].as_str() {
        assets::fetch_bytes(url)?
    } else if let Some(path) = p["path"].as_str() {
        std::fs::read(path).map_err(|e| e.to_string())?
    } else {
        return Err("storeMediaFile needs data, url or path".into());
    };
    assets::save_named(&bytes, &name, dir)
}

/// `note.audio` / `note.picture` / `note.video`: download and reference in the given fields.
fn attach_media(dir: &Path, note: &Value, fields: &mut Map<String, Value>) -> Result<(), String> {
    for (key, picture) in [("audio", false), ("video", false), ("picture", true)] {
        let list = match &note[key] {
            Value::Array(a) => a.clone(),
            Value::Object(_) => vec![note[key].clone()],
            _ => continue,
        };
        for m in list {
            let name = store_media(dir, &m)?;
            let reference = if picture { format!("<img src=\"{name}\">") } else { format!("[sound:{name}]") };
            for f in strings(&m["fields"]) {
                let cur = fields.get(&f).and_then(Value::as_str).unwrap_or("").to_string();
                fields.insert(f, Value::String(cur + &reference));
            }
        }
    }
    Ok(())
}

/// A tiny subset of Anki's search syntax: `deck:`, `note:`, `nid:`, `added:N`,
/// `field:value` (with `*` wildcards), `"quoted terms"`; terms are ANDed.
fn find(conn: &Connection, query: &str, day: i64) -> Result<Vec<i64>, String> {
    let now = engine::now_ts();
    let terms: Vec<String> = {
        let mut out = Vec::new();
        let mut cur = String::new();
        let mut quoted = false;
        for c in query.chars() {
            match c {
                '"' => quoted = !quoted,
                ' ' if !quoted => {
                    if !cur.is_empty() {
                        out.push(std::mem::take(&mut cur));
                    }
                }
                _ => cur.push(c),
            }
        }
        if !cur.is_empty() {
            out.push(cur);
        }
        out
    };
    let matches = |pattern: &str, value: &str| -> bool {
        let v = sentence::html_to_text(value).to_lowercase();
        let p = pattern.to_lowercase();
        if p.contains('*') {
            let parts: Vec<&str> = p.split('*').collect();
            let mut at = 0;
            for (i, part) in parts.iter().enumerate() {
                if part.is_empty() {
                    continue;
                }
                match v[at..].find(part) {
                    Some(j) if i > 0 || j == 0 => at += j + part.len(),
                    _ => return false,
                }
            }
            parts.last().is_some_and(|l| l.is_empty()) || v.ends_with(parts.last().unwrap())
        } else {
            v == p
        }
    };
    let mut out = Vec::new();
    'notes: for (id, fields, created) in sentence::all(conn).map_err(|e| e.to_string())? {
        let status: String = conn.query_row("SELECT status FROM element WHERE id=?1", [id], |r| r.get(0)).map_err(|e| e.to_string())?;
        if status == "dismissed" {
            continue;
        }
        for t in &terms {
            let (neg, t) = t.strip_prefix('-').map_or((false, t.as_str()), |x| (true, x));
            let ok = if let Some(d) = t.strip_prefix("deck:") {
                let deck = sentence::deck_of(conn, id).map_err(|e| e.to_string())?;
                let d = d.trim_end_matches('*').trim_end_matches("::");
                d.is_empty() || deck.eq_ignore_ascii_case(d) || deck.to_lowercase().starts_with(&format!("{}::", d.to_lowercase()))
            } else if let Some(m) = t.strip_prefix("note:") {
                sentence::MODELS.iter().any(|x| x.eq_ignore_ascii_case(m)) || m == "*"
            } else if let Some(n) = t.strip_prefix("nid:").or_else(|| t.strip_prefix("cid:")) {
                n.split(',').any(|x| x.trim().parse::<i64>().ok() == Some(id))
            } else if let Some(n) = t.strip_prefix("added:") {
                let days: i64 = n.parse().unwrap_or(1);
                created >= now - days * 86400
            } else if t.starts_with("is:") || t.starts_with("tag:") || t.starts_with("dupe:") {
                true
            } else if let Some((field, value)) = t.split_once(':') {
                fields.iter().any(|(k, v)| k.eq_ignore_ascii_case(field) && matches(value, v.as_str().unwrap_or("")))
            } else {
                fields.values().any(|v| sentence::html_to_text(v.as_str().unwrap_or("")).to_lowercase().contains(&t.to_lowercase()))
            };
            if ok == neg {
                continue 'notes;
            }
        }
        out.push(id);
    }
    let _ = day;
    Ok(out)
}

fn note_info(conn: &Connection, id: i64) -> Result<Value, String> {
    let fields = sentence::fields_of(conn, id).map_err(|e| e.to_string())?.ok_or("not a sentence note")?;
    let mut f = Map::new();
    for (i, k) in sentence::FIELDS.iter().enumerate() {
        f.insert((*k).to_string(), json!({ "value": fields.get(*k).and_then(Value::as_str).unwrap_or(""), "order": i }));
    }
    let el = engine::get_element(conn, id).map_err(|e| e.to_string())?;
    let modified: i64 = conn.query_row("SELECT updated_at FROM element WHERE id=?1", [id], |r| r.get(0)).map_err(|e| e.to_string())?;
    Ok(json!({ "noteId": id, "profile": "User 1", "modelName": "Senren", "tags": el.tags, "fields": f, "cards": [id], "mod": modified }))
}

fn can_add(conn: &Connection, note: &Value) -> Result<(bool, Option<String>), String> {
    let fields = fields_map(&note["fields"]);
    let first = fields.get("word").or_else(|| fields.values().next()).map(s).unwrap_or_default();
    if sentence::html_to_text(&first).is_empty() {
        return Ok((false, Some("cannot create note because it is empty".into())));
    }
    let allow = note["options"]["allowDuplicate"].as_bool().unwrap_or(false);
    if !allow && sentence::duplicate_of(conn, &first).map_err(|e| e.to_string())?.is_some() {
        return Ok((false, Some("cannot create note because it is a duplicate".into())));
    }
    Ok((true, None))
}

fn add_note(conn: &Connection, ctx: &Ctx, note: &Value) -> Result<i64, String> {
    let (ok, err) = can_add(conn, note)?;
    if !ok {
        return Err(err.unwrap_or_default());
    }
    let mut fields = fields_map(&note["fields"]);
    attach_media(ctx.assets, note, &mut fields)?;
    let parent = sentence::ensure_deck(conn, &s(&note["deckName"]), ctx.day)?;
    let mut tags = strings(&note["tags"]);
    if !tags.iter().any(|t| t == "mined") {
        tags.push("mined".into());
    }
    sentence::create(conn, parent, &fields, &tags, None, None, ctx.day)
}

/// Run one action. Errors are messages, as AnkiConnect reports them.
pub fn action(conn: &Connection, ctx: &Ctx, name: &str, p: &Value) -> Result<Value, String> {
    let day = ctx.day;
    Ok(match name {
        "version" => json!(6),
        "requestPermission" => json!({ "permission": "granted", "requireApikey": false, "version": 6 }),
        "apiReflect" => json!({ "scopes": ["actions"], "actions": ACTIONS }),
        "sync" | "createDeck" => Value::Null,
        "deckNames" | "deckNamesAndIds" => {
            let mut decks = vec![("Default".to_string(), 1i64)];
            let mut stmt = conn
                .prepare("SELECT e.id FROM element e JOIN topic t ON t.element_id = e.id WHERE e.status = 'active' AND t.text_len = 0 ORDER BY e.id")
                .map_err(|e| e.to_string())?;
            let folders: Vec<i64> = stmt.query_map([], |r| r.get(0)).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
            for id in folders {
                let mut path = sentence::deck_of(conn, id)?;
                let title: String = conn.query_row("SELECT title FROM element WHERE id=?1", [id], |r| r.get(0)).map_err(|e| e.to_string())?;
                path = if path == "Default" { title } else { format!("{path}::{title}") };
                if path.matches("::").count() < 4 {
                    decks.push((path, id));
                }
            }
            decks.sort();
            if name == "deckNames" {
                json!(decks.into_iter().map(|d| d.0).collect::<Vec<_>>())
            } else {
                Value::Object(decks.into_iter().map(|(n, i)| (n, json!(i))).collect())
            }
        }
        "modelNames" => json!(sentence::MODELS),
        "modelNamesAndIds" => Value::Object(sentence::MODELS.iter().enumerate().map(|(i, m)| ((*m).to_string(), json!(1_700_000_000_000i64 + i as i64))).collect()),
        "modelFieldNames" => json!(sentence::FIELDS),
        "findNotes" | "findCards" => json!(find(conn, &s(&p["query"]), day)?),
        "cardsToNotes" => json!(ids(&p["cards"])),
        "notesInfo" => {
            let wanted = if p["notes"].is_array() { ids(&p["notes"]) } else { find(conn, &s(&p["query"]), day)? };
            json!(wanted.into_iter().filter_map(|id| note_info(conn, id).ok()).collect::<Vec<_>>())
        }
        "cardsInfo" => json!(ids(&p["cards"])
            .into_iter()
            .filter_map(|id| {
                let mut n = note_info(conn, id).ok()?;
                let deck = sentence::deck_of(conn, id).ok()?;
                n["cardId"] = json!(id);
                n["note"] = json!(id);
                n["deckName"] = json!(deck);
                Some(n)
            })
            .collect::<Vec<_>>()),
        "canAddNotes" => json!(p["notes"].as_array().cloned().unwrap_or_default().iter().map(|n| can_add(conn, n).map(|r| r.0).unwrap_or(false)).collect::<Vec<_>>()),
        "canAddNotesWithErrorDetail" => json!(p["notes"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|n| match can_add(conn, n) {
                Ok((true, _)) => json!({ "canAdd": true }),
                Ok((false, err)) => json!({ "canAdd": false, "error": err }),
                Err(err) => json!({ "canAdd": false, "error": err }),
            })
            .collect::<Vec<_>>()),
        "addNote" => json!(add_note(conn, ctx, &p["note"])?),
        "addNotes" => json!(p["notes"].as_array().cloned().unwrap_or_default().iter().map(|n| add_note(conn, ctx, n).ok()).collect::<Vec<_>>()),
        "updateNoteFields" | "updateNote" => {
            let note = &p["note"];
            let id = note["id"].as_i64().ok_or("note id missing")?;
            let mut fields = fields_map(&note["fields"]);
            attach_media(ctx.assets, note, &mut fields)?;
            if !fields.is_empty() {
                sentence::update(conn, id, &fields)?;
            }
            if name == "updateNote" && note["tags"].is_array() {
                engine::set_tags(conn, id, &strings(&note["tags"]))?;
            }
            Value::Null
        }
        "addTags" | "removeTags" => {
            for tag in s(&p["tags"]).split_whitespace() {
                engine::tag_many(conn, &ids(&p["notes"]), tag, name == "addTags")?;
            }
            Value::Null
        }
        "deleteNotes" => {
            engine::bulk(conn, &ids(&p["notes"]), "delete", None, day)?;
            Value::Null
        }
        "storeMediaFile" => json!(store_media(ctx.assets, p)?),
        "retrieveMediaFile" => match assets::asset_path(ctx.assets, &s(&p["filename"])).and_then(|path| std::fs::read(path).ok()) {
            Some(bytes) => {
                use base64::Engine;
                json!(base64::engine::general_purpose::STANDARD.encode(bytes))
            }
            None => json!(false),
        },
        "getMediaDirPath" => json!(ctx.assets.to_string_lossy()),
        "guiBrowse" => {
            let found = find(conn, &s(&p["query"]), day)?;
            (ctx.show)(found.clone());
            json!(found)
        }
        "guiEditNote" => {
            let id = p["note"].as_i64().ok_or("note id missing")?;
            (ctx.show)(vec![id]);
            Value::Null
        }
        "guiSelectedNotes" => json!([]),
        "multi" => json!(p["actions"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|a| {
                let r = action(conn, ctx, a["action"].as_str().unwrap_or(""), &a["params"]);
                respond(a["version"].as_i64().unwrap_or(6), r)
            })
            .collect::<Vec<_>>()),
        other => return Err(format!("unsupported action: {other}")),
    })
}

/// Shape a result the way AnkiConnect does for the request's API version.
pub fn respond(version: i64, r: Result<Value, String>) -> Value {
    match (version <= 4, r) {
        (true, Ok(v)) => v,
        (_, Err(e)) => json!({ "result": Value::Null, "error": e }),
        (false, Ok(v)) => json!({ "result": v, "error": Value::Null }),
    }
}

/// Web pages may not drive the collection; extensions and local tools may.
fn origin_allowed(origin: Option<&str>) -> bool {
    match origin {
        None | Some("null") => true,
        Some(o) => {
            o.starts_with("chrome-extension://")
                || o.starts_with("moz-extension://")
                || o.starts_with("safari-web-extension://")
                || o.starts_with("http://127.0.0.1")
                || o.starts_with("http://localhost")
        }
    }
}

/// Serve the API on 127.0.0.1:`port` until the app exits.
pub fn start(app: AppHandle, port: u16, key: Option<String>) {
    std::thread::spawn(move || {
        let server = match tiny_http::Server::http(("127.0.0.1", port)) {
            Ok(s) => s,
            Err(err) => {
                eprintln!("AnkiConnect-compatible server not started on port {port}: {err}");
                return;
            }
        };
        for mut req in server.incoming_requests() {
            let origin = req.headers().iter().find(|h| h.field.equiv("Origin")).map(|h| h.value.as_str().to_string());
            let allowed = origin_allowed(origin.as_deref());
            let mut headers = vec![tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap()];
            if allowed {
                if let Some(o) = &origin {
                    headers.push(tiny_http::Header::from_bytes("Access-Control-Allow-Origin", o.as_bytes()).unwrap());
                    headers.push(tiny_http::Header::from_bytes("Access-Control-Allow-Headers", "*").unwrap());
                    headers.push(tiny_http::Header::from_bytes("Access-Control-Allow-Methods", "POST, GET, OPTIONS").unwrap());
                }
            }
            let reply = |req: tiny_http::Request, code: u16, body: String, headers: Vec<tiny_http::Header>| {
                let mut r = tiny_http::Response::from_string(body).with_status_code(code);
                for h in headers {
                    r = r.with_header(h);
                }
                let _ = req.respond(r);
            };
            if !allowed {
                reply(req, 403, r#"{"result":null,"error":"origin not allowed"}"#.into(), headers);
                continue;
            }
            if *req.method() == tiny_http::Method::Options {
                reply(req, 200, String::new(), headers);
                continue;
            }
            let mut raw = String::new();
            if req.as_reader().take(MAX_BODY).read_to_string(&mut raw).is_err() || raw.trim().is_empty() {
                // A plain GET is how tools check that the server is up.
                reply(req, 200, r#""AnkiConnect v.6 (Incremental Reading)""#.into(), headers);
                continue;
            }
            let body: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
            let version = body["version"].as_i64().unwrap_or(4);
            let name = body["action"].as_str().unwrap_or("").to_string();
            let result = if key.as_deref().is_some_and(|k| body["key"].as_str() != Some(k)) {
                Err("valid api key must be provided".to_string())
            } else {
                let state = app.state::<crate::AppState>();
                let changed = !matches!(name.as_str(), "version" | "requestPermission" | "apiReflect" | "deckNames" | "deckNamesAndIds" | "modelNames" | "modelNamesAndIds" | "modelFieldNames" | "findNotes" | "findCards" | "notesInfo" | "cardsInfo" | "canAddNotes" | "canAddNotesWithErrorDetail" | "getMediaDirPath" | "retrieveMediaFile");
                let out = match state.conn.lock() {
                    Ok(conn) => {
                        let ui = app.clone();
                        let show = move |ids: Vec<i64>| {
                            let _ = ui.emit_to("main", "anki-show", ids);
                        };
                        let ctx = Ctx { assets: &state.assets_dir, day: engine::today(), show: &show };
                        action(&conn, &ctx, &name, &body["params"])
                    }
                    Err(e) => Err(e.to_string()),
                };
                if out.is_ok() && changed {
                    let _ = app.emit_to("main", "collection-changed", ());
                }
                out
            };
            reply(req, 200, respond(version, result).to_string(), headers);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn run(c: &Connection, dir: &Path, name: &str, p: Value) -> Result<Value, String> {
        let show = |_: Vec<i64>| {};
        action(c, &Ctx { assets: dir, day: 100, show: &show }, name, &p)
    }

    #[test]
    fn yomitan_flow() {
        let c = db::open_in_memory().unwrap();
        let dir = std::env::temp_dir().join(format!("ir-ac-test-{}", std::process::id()));
        assert_eq!(run(&c, &dir, "version", Value::Null).unwrap(), json!(6));
        assert!(run(&c, &dir, "modelNames", Value::Null).unwrap().as_array().unwrap().contains(&json!("Senren")));
        assert_eq!(run(&c, &dir, "modelFieldNames", json!({ "modelName": "Senren" })).unwrap()[0], "word");

        // Media first, then the note referencing it (what Yomitan does).
        use base64::Engine;
        let data = base64::engine::general_purpose::STANDARD.encode(b"ID3audio");
        let name = run(&c, &dir, "storeMediaFile", json!({ "filename": "yomitan_audio_2025-06-12.mp3", "data": data })).unwrap();
        assert_eq!(name, json!("yomitan_audio_2025-06-12.mp3"));
        let note = json!({
            "deckName": "Japanese::Mining", "modelName": "Senren",
            "fields": { "word": "食べる", "reading": "たべる", "sentence": "彼は<b>食べた</b>。", "glossary": "<ul><li>to eat</li></ul>", "wordAudio": "[sound:yomitan_audio_2025-06-12.mp3]" },
            "tags": ["yomitan"], "options": { "allowDuplicate": false }
        });
        assert_eq!(run(&c, &dir, "canAddNotes", json!({ "notes": [note.clone()] })).unwrap(), json!([true]));
        let id = run(&c, &dir, "addNote", json!({ "note": note.clone() })).unwrap().as_i64().unwrap();
        assert_eq!(run(&c, &dir, "canAddNotes", json!({ "notes": [note.clone()] })).unwrap(), json!([false]));
        assert!(run(&c, &dir, "addNote", json!({ "note": note })).unwrap_err().contains("duplicate"));
        let detail = run(&c, &dir, "canAddNotesWithErrorDetail", json!({ "notes": [{ "fields": { "word": "食べる" } }] })).unwrap();
        assert_eq!(detail[0]["canAdd"], json!(false));

        // Duplicate search the way Yomitan builds it, and mpvacious's "last added".
        assert_eq!(run(&c, &dir, "findNotes", json!({ "query": "\"deck:Japanese\" \"word:食べる\"" })).unwrap(), json!([id]));
        assert_eq!(run(&c, &dir, "findNotes", json!({ "query": "\"word:食べ*\"" })).unwrap(), json!([id]));
        assert_eq!(run(&c, &dir, "findNotes", json!({ "query": "word:飲む" })).unwrap(), json!([]));
        assert_eq!(run(&c, &dir, "findNotes", json!({ "query": "added:1" })).unwrap(), json!([id]));
        let info = run(&c, &dir, "notesInfo", json!({ "notes": [id] })).unwrap();
        assert_eq!(info[0]["fields"]["reading"]["value"], "たべる");
        assert_eq!(info[0]["tags"], json!(["mined", "yomitan"]));

        // mpvacious adds a picture to the last card.
        run(&c, &dir, "updateNoteFields", json!({ "note": { "id": id, "fields": { "picture": "<img src=\"shot.webp\">" } } })).unwrap();
        assert_eq!(sentence::fields_of(&c, id).unwrap().unwrap()["picture"], "<img src=\"shot.webp\">");
        assert_eq!(engine::get_element(&c, id).unwrap().item.unwrap().item_type, "qa");

        assert!(run(&c, &dir, "deckNames", Value::Null).unwrap().as_array().unwrap().contains(&json!("Japanese::Mining")));
        let multi = run(&c, &dir, "multi", json!({ "actions": [{ "action": "version", "version": 6 }, { "action": "bogus" }] })).unwrap();
        assert_eq!(multi[0], json!({ "result": 6, "error": null }));
        assert!(multi[1]["error"].as_str().unwrap().contains("unsupported"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn responses_and_origins() {
        assert_eq!(respond(4, Ok(json!(6))), json!(6));
        assert_eq!(respond(6, Ok(json!(6))), json!({ "result": 6, "error": null }));
        assert_eq!(respond(2, Err("x".into())), json!({ "result": null, "error": "x" }));
        assert!(origin_allowed(Some("chrome-extension://abc")));
        assert!(origin_allowed(None));
        assert!(!origin_allowed(Some("https://evil.example")));
    }
}
