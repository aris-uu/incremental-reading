mod anki;
mod ankiconnect;
mod sentence;
mod assets;
mod db;
mod engine;
mod ext_server;

use std::path::PathBuf;
use std::sync::{Mutex, RwLock};

use rusqlite::Connection;
use serde::Serialize;
use tauri::{Manager, State};

use crate::engine::{
    ElementFull, FullStats, ImportInput, InboxEntry, OptimizeResult, PdfImport, PdfMark, PostponeReport, PostponeSpec, QueueEntry, QueueResult, Result,
    Settings, Stats, TreeNode,
};

/// Most recent first; each entry is a label and the rows to put back.
const UNDO_DEPTH: usize = 30;

struct AppState {
    conn: Mutex<Connection>,
    undo: Mutex<Vec<(String, serde_json::Value)>>,
    /// Rebuilt when the optimizer stores new parameters.
    fsrs: RwLock<fsrs::FSRS>,
    data_dir: PathBuf,
    assets_dir: PathBuf,
}

fn with<T>(state: &State<AppState>, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    f(&conn)
}

/// Run a destructive action after snapshotting the elements it can touch.
fn undoable<T>(
    state: &State<AppState>,
    label: &str,
    affected: impl FnOnce(&Connection) -> Result<Vec<i64>>,
    f: impl FnOnce(&Connection) -> Result<T>,
) -> Result<T> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let ids = affected(&conn)?;
    let snap = engine::snapshot(&conn, &ids)?;
    let out = f(&conn)?;
    let mut undo = state.undo.lock().map_err(|e| e.to_string())?;
    undo.push((label.to_string(), snap));
    if undo.len() > UNDO_DEPTH {
        undo.remove(0);
    }
    Ok(out)
}

/// Undo the most recent destructive action. Returns its label.
#[tauri::command]
fn undo(state: State<AppState>) -> Result<Option<String>> {
    let entry = state.undo.lock().map_err(|e| e.to_string())?.pop();
    let Some((label, snap)) = entry else { return Ok(None) };
    with(&state, |c| engine::restore_snapshot(c, &snap))?;
    Ok(Some(label))
}

fn with_fsrs<T>(state: &State<AppState>, f: impl FnOnce(&Connection, &fsrs::FSRS) -> Result<T>) -> Result<T> {
    let fsrs = state.fsrs.read().map_err(|e| e.to_string())?;
    with(state, |c| f(c, &fsrs))
}

fn today() -> i64 {
    engine::today()
}

// ----- Import -----

/// Async so image downloads run off the UI thread.
#[tauri::command]
async fn import_topic(state: State<'_, AppState>, mut input: ImportInput) -> Result<i64> {
    input.doc_json = assets::localize_images(&input.doc_json, &state.assets_dir);
    with(&state, |c| engine::import_topic(c, &input, today()))
}

#[tauri::command]
async fn fetch_page(url: String) -> Result<assets::FetchedPage> {
    assets::fetch_page(&url)
}

/// Store a file sent as the raw request body (PDFs, EPUB images). The
/// extension comes in the `x-ext` header. Returns the `ir-asset:` reference.
#[tauri::command]
async fn save_asset(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> Result<String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    let ext = request.headers().get("x-ext").and_then(|v| v.to_str().ok()).unwrap_or("bin");
    assets::save_bytes(bytes, ext, &state.assets_dir)
}

#[tauri::command]
fn import_pdf(state: State<AppState>, input: PdfImport) -> Result<i64> {
    with(&state, |c| engine::import_pdf(c, &input, today()))
}

// ----- Elements -----

#[tauri::command]
fn create_extract(state: State<AppState>, parent_id: i64, title: String, doc_json: String) -> Result<i64> {
    with(&state, |c| engine::create_extract(c, parent_id, &title, &doc_json, today()))
}

#[tauri::command]
fn create_topic(state: State<AppState>, parent_id: Option<i64>, title: String, doc_json: String) -> Result<i64> {
    with(&state, |c| engine::create_topic(c, parent_id, &title, &doc_json, today()))
}

#[tauri::command]
fn create_item(state: State<AppState>, parent_id: Option<i64>, item_type: String, question: String, answer: String) -> Result<i64> {
    with(&state, |c| engine::create_item(c, parent_id, &item_type, &question, &answer, today()))
}

#[tauri::command]
fn save_topic(state: State<AppState>, id: i64, doc_json: String, read_point: Option<i64>) -> Result<()> {
    with(&state, |c| engine::save_topic(c, id, &doc_json, read_point))
}

#[tauri::command]
fn save_item(state: State<AppState>, id: i64, question: String, answer: String) -> Result<()> {
    with(&state, |c| engine::save_item(c, id, &question, &answer))
}

#[tauri::command]
fn topic_read(state: State<AppState>, id: i64, duration_ms: Option<i64>) -> Result<i64> {
    with(&state, |c| {
        let n = engine::topic_read(c, id, today())?;
        if let Some(ms) = duration_ms {
            engine::set_last_duration(c, id, ms)?;
        }
        Ok(n)
    })
}

#[tauri::command]
fn reschedule(state: State<AppState>, id: i64, days: i64) -> Result<()> {
    undoable(&state, "Reschedule", |_| Ok(vec![id]), |c| engine::reschedule(c, id, days, today()))
}

#[tauri::command]
fn set_priority(state: State<AppState>, id: i64, priority: f64) -> Result<()> {
    undoable(&state, "Priority", |_| Ok(vec![id]), |c| engine::set_priority(c, id, priority))
}

#[tauri::command]
fn set_afactor(state: State<AppState>, id: i64, afactor: f64) -> Result<()> {
    undoable(&state, "A-Factor", |_| Ok(vec![id]), |c| engine::set_afactor(c, id, afactor))
}

#[tauri::command]
fn set_title(state: State<AppState>, id: i64, title: String) -> Result<()> {
    with(&state, |c| engine::set_title(c, id, &title))
}

#[tauri::command]
fn dismiss(state: State<AppState>, id: i64) -> Result<()> {
    undoable(&state, "Dismiss", |_| Ok(vec![id]), |c| engine::dismiss(c, id, today()))
}

#[tauri::command]
fn done(state: State<AppState>, id: i64) -> Result<()> {
    undoable(&state, "Done!", |_| Ok(vec![id]), |c| engine::done(c, id, today()))
}

#[tauri::command]
fn restore(state: State<AppState>, id: i64) -> Result<()> {
    undoable(&state, "Restore", |_| Ok(vec![id]), |c| engine::restore(c, id, today()))
}

#[tauri::command]
fn accept(state: State<AppState>, id: i64, priority: f64) -> Result<()> {
    undoable(&state, "Accept", |_| Ok(vec![id]), |c| engine::accept(c, id, priority, today()))
}

#[tauri::command]
fn get_inbox(state: State<AppState>) -> Result<Vec<InboxEntry>> {
    with(&state, engine::inbox)
}

#[tauri::command]
fn delete_element(state: State<AppState>, id: i64) -> Result<()> {
    undoable(&state, "Delete", |c| engine::with_children(c, &[id]), |c| engine::delete_element(c, id))
}

#[tauri::command]
fn move_elements(state: State<AppState>, ids: Vec<i64>, parent_id: Option<i64>) -> Result<usize> {
    undoable(&state, "Move", |_| Ok(ids.clone()), |c| engine::move_elements(c, &ids, parent_id))
}

#[tauri::command]
fn priority_anchors(state: State<AppState>) -> Result<Vec<engine::Anchor>> {
    with(&state, engine::priority_anchors)
}

#[tauri::command]
fn place_elements(state: State<AppState>, ids: Vec<i64>, parent_id: Option<i64>, before: Option<i64>) -> Result<()> {
    undoable(
        &state,
        "Move",
        |c| Ok([ids.clone(), engine::siblings(c, parent_id)?].concat()),
        |c| engine::place(c, &ids, parent_id, before),
    )
}

#[tauri::command]
fn shift_element(state: State<AppState>, id: i64, delta: i64) -> Result<()> {
    undoable(
        &state,
        "Reorder",
        |c| {
            let parent = engine::get_element(c, id)?.parent_id;
            engine::siblings(c, parent)
        },
        |c| engine::shift(c, id, delta),
    )
}

#[tauri::command]
fn sort_children(state: State<AppState>, parent_id: Option<i64>) -> Result<()> {
    undoable(&state, "Sort", |c| engine::siblings(c, parent_id), |c| engine::sort_children_by_priority(c, parent_id))
}

#[tauri::command]
fn bulk(state: State<AppState>, ids: Vec<i64>, action: String, priority: Option<f64>) -> Result<usize> {
    let label = match action.as_str() {
        "dismiss" => "Dismiss",
        "done" => "Done!",
        "restore" => "Restore",
        "delete" => "Delete",
        "priority" => "Priority",
        _ => "Change",
    };
    undoable(&state, label, |c| engine::with_children(c, &ids), |c| engine::bulk(c, &ids, &action, priority, today()))
}

#[tauri::command]
fn get_element(state: State<AppState>, id: i64) -> Result<ElementFull> {
    with(&state, |c| engine::get_element(c, id))
}

#[tauri::command]
fn get_tree(state: State<AppState>) -> Result<Vec<TreeNode>> {
    with(&state, engine::tree)
}

#[tauri::command]
fn search(state: State<AppState>, query: String) -> Result<Vec<i64>> {
    with(&state, |c| engine::search(c, &query, 500))
}

// ----- PDF -----

#[tauri::command]
fn set_pdf_page(state: State<AppState>, id: i64, page: i64) -> Result<()> {
    with(&state, |c| engine::set_pdf_page(c, id, page))
}

#[tauri::command]
fn add_pdf_mark(state: State<AppState>, id: i64, child_id: Option<i64>, page: i64, rects: Vec<[f64; 4]>, kind: String) -> Result<i64> {
    with(&state, |c| engine::add_pdf_mark(c, id, child_id, page, &rects, &kind))
}

#[tauri::command]
fn pdf_marks(state: State<AppState>, id: i64) -> Result<Vec<PdfMark>> {
    with(&state, |c| engine::pdf_marks(c, id))
}

#[tauri::command]
fn delete_pdf_mark(state: State<AppState>, mark_id: i64) -> Result<()> {
    with(&state, |c| engine::delete_pdf_mark(c, mark_id))
}

// ----- Items -----

#[tauri::command]
fn preview_item(state: State<AppState>, id: i64) -> Result<[i64; 4]> {
    with_fsrs(&state, |c, f| engine::preview_item(c, f, id, today()))
}

#[tauri::command]
fn grade_item(state: State<AppState>, id: i64, grade: i64, duration_ms: Option<i64>) -> Result<i64> {
    with_fsrs(&state, |c, f| {
        let n = engine::grade_item(c, f, id, grade, today())?;
        if let Some(ms) = duration_ms {
            engine::set_last_duration(c, id, ms)?;
        }
        Ok(n)
    })
}

// ----- Queue and overload -----

#[tauri::command]
fn get_queue(state: State<AppState>) -> Result<QueueResult> {
    with(&state, |c| engine::queue(c, today()))
}

#[tauri::command]
fn branches_queue(state: State<AppState>, roots: Vec<i64>, due_only: bool) -> Result<Vec<QueueEntry>> {
    with(&state, |c| engine::branches_queue(c, &roots, due_only, today()))
}

#[tauri::command]
fn ids_queue(state: State<AppState>, ids: Vec<i64>) -> Result<Vec<QueueEntry>> {
    with(&state, |c| engine::ids_queue(c, &ids))
}

#[tauri::command]
fn postpone(state: State<AppState>, spec: PostponeSpec, simulate: bool) -> Result<PostponeReport> {
    if simulate {
        return with(&state, |c| engine::postpone(c, &spec, true, today()));
    }
    let root = spec.root;
    undoable(&state, "Postpone", |c| engine::due_ids(c, root, today()), |c| engine::postpone(c, &spec, false, today()))
}

#[tauri::command]
fn mercy(state: State<AppState>, root: Option<i64>, days: i64, simulate: bool) -> Result<Vec<i64>> {
    if simulate {
        return with(&state, |c| engine::mercy(c, root, days, true, today()));
    }
    undoable(&state, "Mercy", |c| engine::due_ids(c, root, today()), |c| engine::mercy(c, root, days, false, today()))
}

#[tauri::command]
fn front_load(state: State<AppState>, root: Option<i64>, away: i64, lead: i64, simulate: bool) -> Result<Vec<i64>> {
    if simulate {
        return with(&state, |c| engine::front_load(c, root, away, lead, true, today()));
    }
    undoable(&state, "Before a break", |c| engine::upcoming_ids(c, root, away, today()), |c| engine::front_load(c, root, away, lead, false, today()))
}

#[tauri::command]
fn get_stats(state: State<AppState>) -> Result<Stats> {
    with(&state, |c| engine::stats(c, today()))
}

#[tauri::command]
fn full_stats(state: State<AppState>) -> Result<FullStats> {
    with(&state, |c| engine::full_stats(c, today()))
}

// ----- FSRS optimizer -----

/// Train FSRS on this collection's history. The database lock is held only
/// to read the history and to store the result.
#[tauri::command]
async fn optimize(state: State<'_, AppState>) -> Result<OptimizeResult> {
    let data = with(&state, engine::training_data)?;
    let result = tauri::async_runtime::spawn_blocking(move || engine::fit_parameters(data)).await.map_err(|e| e.to_string())??;
    with(&state, |c| engine::save_parameters(c, &result.parameters))?;
    *state.fsrs.write().map_err(|e| e.to_string())? = engine::fsrs_from(&result.parameters);
    Ok(result)
}

#[tauri::command]
fn reset_parameters(state: State<AppState>) -> Result<()> {
    with(&state, engine::reset_parameters)?;
    *state.fsrs.write().map_err(|e| e.to_string())? = engine::fsrs_from(&fsrs::DEFAULT_PARAMETERS);
    Ok(())
}

// ----- Settings and maintenance -----

#[tauri::command]
fn get_settings(state: State<AppState>) -> Result<Settings> {
    with(&state, engine::get_settings)
}

#[tauri::command]
fn set_settings(state: State<AppState>, settings: Settings) -> Result<()> {
    with(&state, |c| engine::set_settings(c, &settings))
}

#[derive(Serialize)]
struct ExtensionInfo {
    port: u16,
    token: String,
}

#[tauri::command]
fn extension_info(state: State<AppState>) -> Result<ExtensionInfo> {
    with(&state, |c| Ok(ExtensionInfo { port: ext_server::PORT, token: engine::extension_token(c)? }))
}

#[tauri::command]
fn backup(state: State<AppState>) -> Result<String> {
    with(&state, |c| engine::backup(c, &state.data_dir.join("backups")))
}

#[tauri::command]
fn create_clip(state: State<AppState>, parent_id: i64, title: String, start: f64, end: f64, doc_json: String) -> Result<i64> {
    with(&state, |c| engine::create_clip(c, parent_id, &title, start, end, &doc_json, today()))
}

#[tauri::command]
fn set_video_pos(state: State<AppState>, id: i64, pos: f64) -> Result<()> {
    with(&state, |c| engine::set_video_pos(c, id, pos))
}

#[tauri::command]
fn browse_rows(state: State<AppState>) -> Result<Vec<engine::BrowseRow>> {
    with(&state, |c| engine::browse_rows(c, today()))
}

#[tauri::command]
fn set_tags(state: State<AppState>, id: i64, tags: Vec<String>) -> Result<()> {
    undoable(&state, "Tags", |_| Ok(vec![id]), |c| engine::set_tags(c, id, &tags))
}

#[tauri::command]
fn tag_many(state: State<AppState>, ids: Vec<i64>, tag: String, add: bool) -> Result<()> {
    undoable(&state, "Tags", |_| Ok(ids.clone()), |c| engine::tag_many(c, &ids, &tag, add))
}

#[tauri::command]
fn all_tags(state: State<AppState>) -> Result<Vec<(String, i64)>> {
    with(&state, engine::all_tags)
}

#[tauri::command]
fn get_cram(state: State<AppState>) -> Result<Vec<engine::Cram>> {
    with(&state, engine::get_cram)
}

#[tauri::command]
fn set_cram(state: State<AppState>, list: Vec<engine::Cram>) -> Result<()> {
    with(&state, |c| engine::set_cram(c, &list, today()))
}

#[tauri::command]
fn continue_reading(state: State<AppState>) -> Result<Vec<engine::Started>> {
    with(&state, |c| engine::continue_reading(c, 12))
}

#[tauri::command]
fn priority_audit(state: State<AppState>) -> Result<Vec<engine::Anchor>> {
    with(&state, |c| engine::priority_audit(c, today()))
}

#[tauri::command]
fn mark_audited(state: State<AppState>, id: i64) -> Result<()> {
    with(&state, |c| engine::mark_audited(c, id, today()))
}

/// Labels of the undo journal, most recent first.
#[tauri::command]
fn undo_list(state: State<AppState>) -> Result<Vec<String>> {
    Ok(state.undo.lock().map_err(|e| e.to_string())?.iter().rev().map(|(l, _)| l.clone()).collect())
}

/// Generic per-collection UI state (saved searches and the like), as JSON text.
#[tauri::command]
fn get_ui_state(state: State<AppState>, key: String) -> Result<Option<String>> {
    with(&state, |c| engine::get_ui_state(c, &key))
}

#[tauri::command]
fn set_ui_state(state: State<AppState>, key: String, value: String) -> Result<()> {
    with(&state, |c| engine::set_ui_state(c, &key, &value))
}

// ----- Sentence mining -----

#[tauri::command]
fn create_sentence(
    state: State<AppState>,
    parent_id: Option<i64>,
    fields: serde_json::Map<String, serde_json::Value>,
    tags: Vec<String>,
    priority: Option<f64>,
) -> Result<i64> {
    with(&state, |c| sentence::create(c, parent_id, &fields, &tags, priority, today()))
}

#[tauri::command]
fn update_sentence(state: State<AppState>, id: i64, fields: serde_json::Map<String, serde_json::Value>) -> Result<()> {
    undoable(&state, "Edit fields", |_| Ok(vec![id]), |c| sentence::update(c, id, &fields))
}

/// Topic for a deck path like "Japanese::Mining" (created if missing).
#[tauri::command]
fn ensure_deck(state: State<AppState>, deck: String) -> Result<Option<i64>> {
    with(&state, |c| sentence::ensure_deck(c, &deck, today()))
}

/// Store media returned by the Yomitan API under its own name.
#[tauri::command]
fn save_media(state: State<AppState>, name: String, base64: String) -> Result<String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(base64.trim()).map_err(|e| e.to_string())?;
    assets::save_named(&bytes, &name, &state.assets_dir)
}

/// POST to the local Yomitan API (yomitan-api), from the core so the webview's
/// CORS rules don't apply. Loopback addresses only.
#[tauri::command]
async fn yomitan_api(base: String, path: String, body: serde_json::Value) -> Result<serde_json::Value> {
    let base = base.trim_end_matches('/').to_string();
    if !(base.starts_with("http://127.0.0.1") || base.starts_with("http://localhost") || base.starts_with("http://[::1]")) {
        return Err("The Yomitan API address must be on this computer (127.0.0.1 or localhost)".into());
    }
    let path: String = path.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    tauri::async_runtime::spawn_blocking(move || {
        let resp = ureq::AgentBuilder::new()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .post(&format!("{base}/{path}"))
            .set("Content-Type", "application/json")
            .send_string(&body.to_string())
            .map_err(|e| format!("Yomitan API: {e}"))?;
        let text = resp.into_string().map_err(|e| e.to_string())?;
        serde_json::from_str::<serde_json::Value>(&text).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, serde::Deserialize, Default)]
struct AnkiConnectSettings {
    /// 0 = off.
    port: u16,
    key: Option<String>,
}

fn ankiconnect_settings(c: &Connection) -> Result<AnkiConnectSettings> {
    Ok(engine::get_ui_state(c, "ankiconnect")?
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(AnkiConnectSettings { port: ankiconnect::DEFAULT_PORT, key: None }))
}

#[tauri::command]
fn get_ankiconnect(state: State<AppState>) -> Result<AnkiConnectSettings> {
    with(&state, ankiconnect_settings)
}

/// Takes effect at the next start of the app.
#[tauri::command]
fn set_ankiconnect(state: State<AppState>, port: u16, key: Option<String>) -> Result<()> {
    let key = key.filter(|k| !k.trim().is_empty());
    with(&state, |c| engine::set_ui_state(c, "ankiconnect", &serde_json::to_string(&AnkiConnectSettings { port, key }).map_err(|e| e.to_string())?))
}

#[tauri::command]
fn append_lines(state: State<AppState>, id: i64, lines: Vec<String>, heading: Option<String>) -> Result<i64> {
    with(&state, |c| engine::append_lines(c, id, &lines, heading.as_deref()))
}

#[tauri::command]
fn set_flag(state: State<AppState>, id: i64, flag: String, value: bool) -> Result<()> {
    with(&state, |c| engine::set_flag(c, id, &flag, value))
}

#[tauri::command]
fn session_summary(state: State<AppState>, since_ts: i64) -> Result<engine::SessionSummary> {
    with(&state, |c| engine::session_summary(c, since_ts))
}

#[tauri::command]
fn export_items(state: State<AppState>, roots: Option<Vec<i64>>) -> Result<Vec<engine::ExportItem>> {
    with(&state, |c| engine::export_items(c, roots.as_deref()))
}

/// Write rendered cards as an Anki package in `exports`. Returns the path.
#[tauri::command]
async fn export_apkg(state: State<'_, AppState>, cards: Vec<anki::AnkiCard>) -> Result<String> {
    let path = anki::export_apkg(&cards, &state.assets_dir, &state.data_dir.join("exports"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn data_dir(state: State<AppState>) -> String {
    state.data_dir.to_string_lossy().into_owned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Opens links in the system browser.
        .plugin(tauri_plugin_opener::init())
        // Locally stored files: irasset://localhost/<file> (http://irasset.localhost/<file> on Windows).
        .register_uri_scheme_protocol("irasset", |ctx, request| {
            let dir = ctx.app_handle().state::<AppState>().assets_dir.clone();
            let found = assets::asset_path(&dir, request.uri().path()).and_then(|p| std::fs::read(&p).ok().map(|b| (p, b)));
            match found {
                Some((path, bytes)) => tauri::http::Response::builder()
                    .header("Content-Type", assets::mime_for(&path))
                    .header("Cache-Control", "max-age=31536000, immutable")
                    .header("Access-Control-Allow-Origin", "*")
                    .body(bytes)
                    .unwrap(),
                None => tauri::http::Response::builder().status(404).body(Vec::new()).unwrap(),
            }
        })
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let (conn, from_version) = db::open(&data_dir.join("collection.sqlite"))?;
            if from_version > 0 && from_version < db::LATEST {
                engine::reindex_all(&conn)?;
            }
            engine::recompute_priorities(&conn)?;
            let token = engine::extension_token(&conn)?;
            let params = engine::fsrs_params(&conn)?;
            app.manage(AppState {
                conn: Mutex::new(conn),
                undo: Mutex::new(Vec::new()),
                fsrs: RwLock::new(engine::fsrs_from(&params)),
                assets_dir: data_dir.join("assets"),
                data_dir,
            });
            ext_server::start(app.handle().clone(), token);
            let ac = {
                let state = app.state::<AppState>();
                let conn = state.conn.lock().map_err(|e| e.to_string())?;
                ankiconnect_settings(&conn)?
            };
            if ac.port != 0 {
                ankiconnect::start(app.handle().clone(), ac.port, ac.key);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            import_topic,
            fetch_page,
            save_asset,
            import_pdf,
            create_extract,
            create_topic,
            create_item,
            save_topic,
            save_item,
            topic_read,
            reschedule,
            set_priority,
            set_title,
            dismiss,
            done,
            restore,
            accept,
            get_inbox,
            delete_element,
            move_elements,
            place_elements,
            priority_anchors,
            undo,
            shift_element,
            sort_children,
            bulk,
            get_element,
            get_tree,
            search,
            set_pdf_page,
            add_pdf_mark,
            pdf_marks,
            delete_pdf_mark,
            preview_item,
            grade_item,
            get_queue,
            branches_queue,
            ids_queue,
            postpone,
            mercy,
            front_load,
            get_stats,
            full_stats,
            optimize,
            reset_parameters,
            get_settings,
            set_settings,
            extension_info,
            backup,
            data_dir,
            set_flag,
            append_lines,
            create_sentence,
            update_sentence,
            ensure_deck,
            save_media,
            yomitan_api,
            get_ankiconnect,
            set_ankiconnect,
            set_afactor,
            browse_rows,
            set_tags,
            tag_many,
            all_tags,
            get_cram,
            set_cram,
            continue_reading,
            priority_audit,
            mark_audited,
            undo_list,
            get_ui_state,
            set_ui_state,
            create_clip,
            set_video_pos,
            session_summary,
            export_items,
            export_apkg,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the app");
}
