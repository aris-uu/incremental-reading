//! Local copies of images (so articles survive the web changing) and URL fetching.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Prefix for images stored in the collection's assets folder. The UI maps it
/// to the `irasset` URI scheme served by the app.
pub const ASSET_PREFIX: &str = "ir-asset:";
const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_PAGE_BYTES: u64 = 15 * 1024 * 1024;
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) IncrementalReading/0.1";

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(Duration::from_secs(20)).redirects(5).build()
}

fn extension_for(content_type: &str, url: &str) -> &'static str {
    let ct = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    match ct.as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "image/avif" => "avif",
        _ => {
            let path = url.split(['?', '#']).next().unwrap_or("").to_ascii_lowercase();
            ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"]
                .into_iter()
                .find(|ext| path.ends_with(&format!(".{ext}")))
                .map(|ext| if ext == "jpeg" { "jpg" } else { ext })
                .unwrap_or("img")
        }
    }
}

/// Download one image into `dir`, named by content hash. Returns the file name.
fn download(url: &str, dir: &Path) -> Result<String, String> {
    let resp = agent().get(url).set("User-Agent", USER_AGENT).call().map_err(|e| e.to_string())?;
    let ct = resp.header("Content-Type").unwrap_or("").to_string();
    if !ct.is_empty() && !ct.starts_with("image/") {
        return Err(format!("not an image: {ct}"));
    }
    let mut bytes = Vec::new();
    resp.into_reader().take(MAX_IMAGE_BYTES).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let hash = Sha256::digest(&bytes);
    let hex: String = hash.iter().take(16).map(|b| format!("{b:02x}")).collect();
    let name = format!("{hex}.{}", extension_for(&ct, url));
    let path = dir.join(&name);
    if !path.exists() {
        std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    }
    Ok(name)
}

/// Replace remote image sources in a ProseMirror document with local copies.
/// Images that fail to download keep their remote URL.
pub fn localize_images(doc_json: &str, dir: &Path) -> String {
    fn walk(v: &mut Value, dir: &Path, changed: &mut bool) {
        if v.get("type").and_then(Value::as_str) == Some("image") {
            if let Some(src) = v.pointer("/attrs/src").and_then(Value::as_str).map(str::to_owned) {
                if src.starts_with("http://") || src.starts_with("https://") {
                    if let Ok(name) = download(&src, dir) {
                        v["attrs"]["src"] = Value::String(format!("{ASSET_PREFIX}{name}"));
                        *changed = true;
                    }
                }
            }
        }
        if let Some(children) = v.get_mut("content").and_then(Value::as_array_mut) {
            for c in children {
                walk(c, dir, changed);
            }
        }
    }
    let Ok(mut v) = serde_json::from_str::<Value>(doc_json) else { return doc_json.to_string() };
    if std::fs::create_dir_all(dir).is_err() {
        return doc_json.to_string();
    }
    let mut changed = false;
    walk(&mut v, dir, &mut changed);
    if changed {
        v.to_string()
    } else {
        doc_json.to_string()
    }
}

/// Store uploaded bytes in the assets folder, named by content hash.
/// Returns the stored reference (`ir-asset:<file>`).
pub fn save_bytes(bytes: &[u8], ext: &str, dir: &Path) -> Result<String, String> {
    let ext: String = ext.chars().filter(|c| c.is_ascii_alphanumeric()).take(5).collect::<String>().to_ascii_lowercase();
    let ext = if ext.is_empty() { "bin".to_string() } else { ext };
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let hex: String = Sha256::digest(bytes).iter().take(16).map(|b| format!("{b:02x}")).collect();
    let name = format!("{hex}.{ext}");
    let path = dir.join(&name);
    if !path.exists() {
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    }
    Ok(format!("{ASSET_PREFIX}{name}"))
}

/// Resolve an `irasset` request path to a file inside the assets folder.
/// Only plain hash-named files are served.
pub fn asset_path(dir: &Path, request_path: &str) -> Option<PathBuf> {
    let name = request_path.trim_start_matches('/');
    let ok = !name.is_empty() && name.len() < 80 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.') && !name.contains("..");
    ok.then(|| dir.join(name))
}

pub fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

#[derive(Serialize)]
pub struct FetchedPage {
    pub html: String,
    pub final_url: String,
}

/// Fetch a web page for URL import. The UI runs Readability on the result.
pub fn fetch_page(url: &str) -> Result<FetchedPage, String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Only http(s) URLs can be imported".into());
    }
    let resp = agent()
        .get(url)
        .set("User-Agent", USER_AGENT)
        .set("Accept", "text/html,application/xhtml+xml")
        .call()
        .map_err(|e| e.to_string())?;
    let final_url = resp.get_url().to_string();
    let mut bytes = Vec::new();
    resp.into_reader().take(MAX_PAGE_BYTES).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok(FetchedPage { html: String::from_utf8_lossy(&bytes).into_owned(), final_url })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_paths_are_confined() {
        let d = Path::new("/assets");
        assert!(asset_path(d, "/abc123.png").is_some());
        assert!(asset_path(d, "/../secret").is_none());
        assert!(asset_path(d, "/a/b.png").is_none());
        assert!(asset_path(d, "/a\\b.png").is_none());
        assert!(asset_path(d, "/").is_none());
    }

    #[test]
    fn extensions_from_type_or_url() {
        assert_eq!(extension_for("image/png", "x"), "png");
        assert_eq!(extension_for("", "https://x/y.JPEG?w=3"), "jpg");
        assert_eq!(extension_for("application/octet-stream", "https://x/y"), "img");
    }

    #[test]
    fn non_remote_images_are_left_alone() {
        let doc = r#"{"type":"doc","content":[{"type":"image","attrs":{"src":"ir-asset:a.png"}}]}"#;
        assert_eq!(localize_images(doc, &std::env::temp_dir()), doc);
    }
}
