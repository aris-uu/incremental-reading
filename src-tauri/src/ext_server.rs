//! Local HTTP bridge for the browser extension.
//!
//! Listens on 127.0.0.1 only. Every request must carry the collection's
//! secret token in `X-IR-Token`. A web page can't add that header to a
//! cross-origin request without a CORS preflight, and we never answer
//! preflights, so only the extension (which has host permission) gets through.
//! The page HTML is forwarded to the main window, which converts it with the
//! same editor schema as everything else.

use std::io::Read;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

pub const PORT: u16 = 47811;
const MAX_BODY: u64 = 30 * 1024 * 1024;

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct ExternalImport {
    pub title: String,
    pub url: Option<String>,
    pub html: String,
    pub priority: Option<f64>,
    pub site: Option<String>,
    pub author: Option<String>,
}

pub fn start(app: AppHandle, token: String) {
    std::thread::spawn(move || {
        let server = match tiny_http::Server::http(("127.0.0.1", PORT)) {
            Ok(s) => s,
            Err(err) => {
                eprintln!("extension bridge not started on port {PORT}: {err}");
                return;
            }
        };
        for mut req in server.incoming_requests() {
            let authorized = req
                .headers()
                .iter()
                .any(|h| h.field.equiv("X-IR-Token") && h.value.as_str() == token);
            let (code, body) = if !authorized {
                (401, r#"{"ok":false,"error":"bad token"}"#.to_string())
            } else {
                match (req.method(), req.url()) {
                    (tiny_http::Method::Get, "/ping") => (200, r#"{"ok":true}"#.to_string()),
                    (tiny_http::Method::Post, "/import") => {
                        let mut raw = String::new();
                        let read = req.as_reader().take(MAX_BODY).read_to_string(&mut raw);
                        match read.map_err(|e| e.to_string()).and_then(|_| serde_json::from_str::<ExternalImport>(&raw).map_err(|e| e.to_string())) {
                            Ok(payload) => match app.emit_to("main", "external-import", payload) {
                                Ok(()) => (200, r#"{"ok":true}"#.to_string()),
                                Err(e) => (500, serde_json::json!({"ok":false,"error":e.to_string()}).to_string()),
                            },
                            Err(e) => (400, serde_json::json!({"ok":false,"error":e}).to_string()),
                        }
                    }
                    _ => (404, r#"{"ok":false}"#.to_string()),
                }
            };
            let header = tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap();
            let _ = req.respond(tiny_http::Response::from_string(body).with_status_code(code).with_header(header));
        }
    });
}
