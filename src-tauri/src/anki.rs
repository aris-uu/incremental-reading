//! Anki export: write items as an `.apkg` (a zip holding a legacy
//! `collection.anki2` SQLite file, the media map and the media files).
//!
//! Cards are exported as new "Basic" notes (Front/Back), one deck per
//! top-level root under `Incremental reading::`. Note GUIDs are derived from
//! the element id, so exporting again updates the same notes in Anki
//! instead of duplicating them.

use std::io::Write;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::json;

use crate::assets;

#[derive(Deserialize, Debug, Clone)]
pub struct AnkiCard {
    /// Element id (used for the note GUID).
    pub id: i64,
    pub front: String,
    pub back: String,
    pub deck: String,
}

/// Fixed model id so repeated exports reuse the same note type in Anki.
const MODEL_ID: i64 = 1_607_392_319_001;
const DECK_ROOT: &str = "Incremental reading";

const SCHEMA: &str = r#"
CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null,
  dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null,
  dconf text not null, tags text not null);
CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null,
  tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null);
CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null,
  usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null,
  reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null,
  flags integer not null, data text not null);
CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null,
  lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_usn on notes (usn);
CREATE INDEX ix_cards_usn on cards (usn);
CREATE INDEX ix_revlog_usn on revlog (usn);
CREATE INDEX ix_cards_nid on cards (nid);
CREATE INDEX ix_cards_sched on cards (did, queue, due);
CREATE INDEX ix_revlog_cid on revlog (cid);
CREATE INDEX ix_notes_csum on notes (csum);
"#;

const CSS: &str = ".card { font-family: Georgia, serif; font-size: 20px; text-align: left; color: black; background-color: white; }
.ir-ref { margin-top: 1.2em; font-size: 13px; color: #777; }
img { max-width: 100%; }
.ir-occl { position: relative; display: inline-block; }
.ir-occl img { display: block; }
.ir-occl .mask { position: absolute; background: #9ca3af; border: 1px solid #555; }
.ir-occl .mask.active { background: #f59e0b; }
.ir-occl .mask.revealed { background: transparent; border: 2px solid #f59e0b; }";

fn deck_id(name: &str) -> i64 {
    // Stable per name, well away from the default deck (1).
    let h = sha1_smol::Sha1::from(name).digest().bytes();
    1_000_000_000 + (i64::from_be_bytes([0, 0, 0, 0, h[0], h[1], h[2], h[3]]) % 1_000_000_000)
}

/// Field checksum Anki uses for duplicate detection: first 8 hex digits of SHA-1 of the stripped sort field.
fn checksum(field: &str) -> i64 {
    let text = strip_html(field);
    let h = sha1_smol::Sha1::from(text.as_str()).digest().bytes();
    i64::from_be_bytes([0, 0, 0, 0, h[0], h[1], h[2], h[3]])
}

fn strip_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.trim().to_string()
}

/// Media references (`src="<file>"`) that name files in the assets folder.
fn media_in(html: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = html;
    while let Some(i) = rest.find("src=\"") {
        rest = &rest[i + 5..];
        let Some(end) = rest.find('"') else { break };
        let name = &rest[..end];
        if !name.contains(':') && !name.contains('/') && !name.is_empty() {
            out.push(name.to_string());
        }
        rest = &rest[end..];
    }
    out
}

fn deck_json(id: i64, name: &str, now: i64) -> serde_json::Value {
    json!({
        "id": id, "name": name, "mod": now, "usn": -1, "desc": "", "dyn": 0, "conf": 1, "collapsed": false, "browserCollapsed": false,
        "extendNew": 10, "extendRev": 50, "newToday": [0, 0], "revToday": [0, 0], "lrnToday": [0, 0], "timeToday": [0, 0]
    })
}

/// Build the `collection.anki2` database at `path`.
fn write_collection(path: &Path, cards: &[AnkiCard], now: i64) -> Result<(), String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;

    let mut decks = serde_json::Map::new();
    decks.insert("1".into(), deck_json(1, "Default", now));
    for c in cards {
        let name = format!("{DECK_ROOT}::{}", c.deck.replace("::", ":"));
        let id = deck_id(&name);
        decks.entry(id.to_string()).or_insert_with(|| deck_json(id, &name, now));
    }
    let field = |name: &str, ord: i64| json!({ "name": name, "ord": ord, "sticky": false, "rtl": false, "font": "Arial", "size": 20, "media": [] });
    let models = json!({
        MODEL_ID.to_string(): {
            "id": MODEL_ID, "name": "Incremental reading (Basic)", "type": 0, "mod": now, "usn": -1, "sortf": 0, "did": 1,
            "tmpls": [{ "name": "Card 1", "ord": 0, "qfmt": "{{Front}}", "afmt": "{{FrontSide}}<hr id=answer>{{Back}}",
                        "bqfmt": "", "bafmt": "", "did": null, "bfont": "", "bsize": 0 }],
            "flds": [field("Front", 0), field("Back", 1)],
            "css": CSS, "latexPre": "\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n",
            "latexPost": "\\end{document}", "latexsvg": false, "tags": [], "vers": [], "req": [[0, "any", [0]]]
        }
    });
    let conf = json!({
        "activeDecks": [1], "curDeck": 1, "newSpread": 0, "collapseTime": 1200, "timeLim": 0, "estTimes": true, "dueCounts": true,
        "curModel": MODEL_ID.to_string(), "nextPos": cards.len() + 1, "sortType": "noteFld", "sortBackwards": false, "addToCur": true
    });
    let dconf = json!({ "1": {
        "id": 1, "name": "Default", "mod": 0, "usn": 0, "maxTaken": 60, "autoplay": true, "timer": 0, "replayq": true, "dyn": false,
        "new": { "bury": true, "delays": [1.0, 10.0], "initialFactor": 2500, "ints": [1, 4, 7], "order": 1, "perDay": 20, "separate": true },
        "lapse": { "delays": [10.0], "leechAction": 0, "leechFails": 8, "minInt": 1, "mult": 0.0 },
        "rev": { "bury": true, "ease4": 1.3, "fuzz": 0.05, "ivlFct": 1.0, "maxIvl": 36500, "minSpace": 1, "perDay": 200 }
    }});
    conn.execute(
        "INSERT INTO col VALUES (1, ?1, ?2, ?2, 11, 0, 0, 0, ?3, ?4, ?5, ?6, '{}')",
        params![now / 86400 * 86400, now * 1000, conf.to_string(), models.to_string(), serde_json::Value::Object(decks).to_string(), dconf.to_string()],
    )
    .map_err(|e| e.to_string())?;

    for (i, c) in cards.iter().enumerate() {
        let nid = now * 1000 + i as i64;
        let did = deck_id(&format!("{DECK_ROOT}::{}", c.deck.replace("::", ":")));
        let flds = format!("{}\x1f{}", c.front, c.back);
        conn.execute(
            "INSERT INTO notes VALUES (?1, ?2, ?3, ?4, -1, ' incremental-reading ', ?5, ?6, ?7, 0, '')",
            params![nid, format!("ir-{}", c.id), MODEL_ID, now, flds, strip_html(&c.front), checksum(&c.front)],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO cards VALUES (?1, ?2, ?3, 0, ?4, -1, 0, 0, ?5, 0, 0, 0, 0, 0, 0, 0, 0, '')",
            params![nid, nid, did, now, i as i64 + 1],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Write `cards` as an Anki package into `out_dir`. Images referenced as
/// `src="<file>"` are copied from `assets_dir`. Returns the file path.
pub fn export_apkg(cards: &[AnkiCard], assets_dir: &Path, out_dir: &Path) -> Result<PathBuf, String> {
    if cards.is_empty() {
        return Err("No items to export".into());
    }
    std::fs::create_dir_all(out_dir).map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().timestamp();
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let tmp = out_dir.join(format!(".collection-{stamp}.anki2"));
    let _ = std::fs::remove_file(&tmp);
    let built = write_collection(&tmp, cards, now);
    let collection = built.and_then(|_| std::fs::read(&tmp).map_err(|e| e.to_string()));
    let _ = std::fs::remove_file(&tmp);
    let collection = collection?;

    let mut media: Vec<String> = Vec::new();
    for c in cards {
        for m in media_in(&c.front).into_iter().chain(media_in(&c.back)) {
            if !media.contains(&m) {
                media.push(m);
            }
        }
    }

    let path = out_dir.join(format!("ir-export-{stamp}.apkg"));
    let file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("collection.anki2", opts).map_err(|e| e.to_string())?;
    zip.write_all(&collection).map_err(|e| e.to_string())?;
    let mut map = serde_json::Map::new();
    let mut n = 0;
    for name in &media {
        let Some(p) = assets::asset_path(assets_dir, name) else { continue };
        let Ok(bytes) = std::fs::read(&p) else { continue };
        zip.start_file(n.to_string(), opts).map_err(|e| e.to_string())?;
        zip.write_all(&bytes).map_err(|e| e.to_string())?;
        map.insert(n.to_string(), serde_json::Value::String(name.clone()));
        n += 1;
    }
    zip.start_file("media", opts).map_err(|e| e.to_string())?;
    zip.write_all(serde_json::Value::Object(map).to_string().as_bytes()).map_err(|e| e.to_string())?;
    zip.finish().map_err(|e| e.to_string())?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn media_references_are_found() {
        let html = r#"<p><img src="abc.png"> <img src="https://x/y.png"> <img src="def.jpg"></p>"#;
        assert_eq!(media_in(html), vec!["abc.png", "def.jpg"]);
    }

    #[test]
    fn writes_a_package() {
        let dir = std::env::temp_dir().join(format!("ir-anki-test-{}", std::process::id()));
        let assets = dir.join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::write(assets.join("abc.png"), b"png").unwrap();
        let cards = vec![
            AnkiCard { id: 1, front: "Leptin is made by [...]".into(), back: "fat cells".into(), deck: "Biology".into() },
            AnkiCard { id: 2, front: r#"<img src="abc.png">"#.into(), back: "x".into(), deck: "Biology".into() },
        ];
        let path = export_apkg(&cards, &assets, &dir).unwrap();
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&path).unwrap()).unwrap();
        let mut media = String::new();
        zip.by_name("media").unwrap().read_to_string(&mut media).unwrap();
        assert_eq!(media, r#"{"0":"abc.png"}"#);
        let mut col = Vec::new();
        zip.by_name("collection.anki2").unwrap().read_to_end(&mut col).unwrap();
        let db = dir.join("check.anki2");
        std::fs::write(&db, col).unwrap();
        let c = Connection::open(&db).unwrap();
        let n: i64 = c.query_row("SELECT COUNT(*) FROM cards", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
        let guid: String = c.query_row("SELECT guid FROM notes ORDER BY id LIMIT 1", [], |r| r.get(0)).unwrap();
        assert_eq!(guid, "ir-1");
        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
