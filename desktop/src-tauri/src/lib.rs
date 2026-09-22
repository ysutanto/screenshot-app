use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, Manager, Wry,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_opener::OpenerExt;

const CAPTURE_SHORTCUT: &str = "CommandOrControl+Shift+9";

fn upload_api_base() -> String {
    std::env::var("UPLOAD_API_BASE")
        .unwrap_or_else(|_| "https://actava-screenshot.vercel.app".to_string())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
enum CaptureStatus {
    Capturing,
    Recording,
    Uploading,
    Done { share_url: String },
    Cancelled,
    Error { message: String },
}

#[derive(Deserialize)]
struct UploadResponse {
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresignResponse {
    upload_url: String,
    url: String,
}

enum CaptureMode {
    Region,
    Window,
    Screen,
}

fn emit_status(app: &AppHandle, status: CaptureStatus) {
    let _ = app.emit("capture-status", status);
}

/// Run an AppleScript and return its trimmed stdout, or `None` on failure/empty.
#[cfg(target_os = "macos")]
fn run_osascript(script: &str) -> Option<String> {
    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// If the frontmost app is a supported browser, return its active tab's URL.
/// Uses AppleScript (Apple Events); returns `None` when the front app isn't a
/// browser, on any scripting error, or if automation permission is denied.
///
/// The frontmost app name is resolved first (System Events only, so the script
/// always compiles), then a *literal* `tell` targets that browser — a variable
/// app name can't be compiled against app-specific terminology like `URL`.
#[cfg(target_os = "macos")]
fn frontmost_browser_url() -> Option<String> {
    // Chromium-family browsers share the same scripting terms; Safari differs.
    const CHROMIUM: &[&str] = &[
        "Google Chrome",
        "Google Chrome Beta",
        "Google Chrome Canary",
        "Chromium",
        "Brave Browser",
        "Microsoft Edge",
        "Arc",
        "Vivaldi",
        "Opera",
    ];

    let front = run_osascript(
        r#"tell application "System Events" to get name of first application process whose frontmost is true"#,
    )?;

    // `front` is constrained to the literals below before interpolation.
    let script = if front == "Safari" {
        r#"tell application "Safari" to get URL of front document"#.to_string()
    } else if CHROMIUM.contains(&front.as_str()) {
        format!(r#"tell application "{front}" to get URL of active tab of front window"#)
    } else {
        return None;
    };

    let url = run_osascript(&script)?;
    if url.starts_with("http://") || url.starts_with("https://") {
        Some(url)
    } else {
        None
    }
}

#[cfg(not(target_os = "macos"))]
fn frontmost_browser_url() -> Option<String> {
    None
}

async fn capture_and_share(app: AppHandle, mode: CaptureMode) {
    emit_status(&app, CaptureStatus::Capturing);

    // Capture the source URL from the frontmost browser *before* the interactive
    // window picker runs (it would change the frontmost app). Only for window
    // captures — a region or full-screen grab isn't tied to one browser window.
    let source_url = match mode {
        CaptureMode::Window => frontmost_browser_url(),
        _ => None,
    };

    let tmp_path = std::env::temp_dir().join(format!(
        "screenshot-app-{}.png",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));

    let mut args = vec!["-x"];
    match mode {
        CaptureMode::Region => { args.push("-i"); }
        CaptureMode::Window => { args.push("-i"); args.push("-w"); }
        CaptureMode::Screen => {} // no extra flags — captures main display immediately
    }
    args.push(tmp_path.to_str().unwrap());

    let spawn_result = std::process::Command::new("screencapture")
        .args(&args)
        .status();

    let captured = match spawn_result {
        Ok(status) if status.success() => tmp_path.exists(),
        Ok(_) => false,
        Err(err) => {
            emit_status(
                &app,
                CaptureStatus::Error {
                    message: format!("Failed to run screencapture: {err}"),
                },
            );
            return;
        }
    };

    if !captured {
        emit_status(&app, CaptureStatus::Cancelled);
        return;
    }

    let bytes = match std::fs::read(&tmp_path) {
        Ok(bytes) => bytes,
        Err(err) => {
            emit_status(
                &app,
                CaptureStatus::Error {
                    message: format!("Failed to read screenshot: {err}"),
                },
            );
            return;
        }
    };
    let _ = std::fs::remove_file(&tmp_path);

    upload_and_open(&app, bytes, "screenshot.png", "image/png", source_url).await;
}

/// Upload a captured file (image or video) to the backend and open the
/// returned share URL in the browser. Emits status updates throughout.
async fn upload_and_open(
    app: &AppHandle,
    bytes: Vec<u8>,
    file_name: &str,
    mime: &str,
    source_url: Option<String>,
) {
    emit_status(app, CaptureStatus::Uploading);

    let part = match reqwest::multipart::Part::bytes(bytes)
        .file_name(file_name.to_string())
        .mime_str(mime)
    {
        Ok(part) => part,
        Err(err) => {
            emit_status(
                app,
                CaptureStatus::Error {
                    message: format!("Failed to build upload request: {err}"),
                },
            );
            return;
        }
    };
    let mut form = reqwest::multipart::Form::new().part("file", part);
    if let Some(url) = source_url {
        form = form.text("sourceUrl", url);
    }

    let client = reqwest::Client::new();
    let response = client
        .post(format!("{}/api/upload", upload_api_base()))
        .multipart(form)
        .send()
        .await;

    let upload = match response {
        Ok(res) if res.status().is_success() => res.json::<UploadResponse>().await,
        Ok(res) => {
            emit_status(
                app,
                CaptureStatus::Error {
                    message: format!("Upload failed with status {}", res.status()),
                },
            );
            return;
        }
        Err(err) => {
            emit_status(
                app,
                CaptureStatus::Error {
                    message: format!("Upload failed: {err}"),
                },
            );
            return;
        }
    };

    let share_path = match upload {
        Ok(body) => body.url,
        Err(err) => {
            emit_status(
                app,
                CaptureStatus::Error {
                    message: format!("Unexpected upload response: {err}"),
                },
            );
            return;
        }
    };

    let share_url = format!("{}{}", upload_api_base(), share_path);

    if let Err(err) = app.opener().open_url(share_url.clone(), None::<String>) {
        emit_status(
            app,
            CaptureStatus::Error {
                message: format!("Uploaded, but couldn't open the browser: {err}"),
            },
        );
        return;
    }

    emit_status(app, CaptureStatus::Done { share_url });
}

/// Upload a recording directly to Blob storage via a presigned PUT URL. This
/// bypasses the 4.5 MB Function request-body limit so recordings can be any
/// length. Step 1: ask the backend for a presigned URL. Step 2: PUT the bytes
/// straight to Blob. Step 3: open the share page.
async fn upload_recording(app: &AppHandle, bytes: Vec<u8>) {
    emit_status(app, CaptureStatus::Uploading);

    let client = reqwest::Client::new();

    let presign = client
        .post(format!("{}/api/upload/presign", upload_api_base()))
        .json(&serde_json::json!({ "contentType": "video/mp4" }))
        .send()
        .await;

    let presign = match presign {
        Ok(res) if res.status().is_success() => res.json::<PresignResponse>().await,
        Ok(res) => {
            emit_status(
                app,
                CaptureStatus::Error {
                    message: format!("Could not prepare upload (status {})", res.status()),
                },
            );
            return;
        }
        Err(err) => {
            emit_status(
                app,
                CaptureStatus::Error {
                    message: format!("Could not prepare upload: {err}"),
                },
            );
            return;
        }
    };

    let PresignResponse { upload_url, url } = match presign {
        Ok(body) => body,
        Err(err) => {
            emit_status(
                app,
                CaptureStatus::Error {
                    message: format!("Unexpected presign response: {err}"),
                },
            );
            return;
        }
    };

    let put = client
        .put(&upload_url)
        .header("content-type", "video/mp4")
        .body(bytes)
        .send()
        .await;

    match put {
        Ok(res) if res.status().is_success() => {}
        Ok(res) => {
            emit_status(
                app,
                CaptureStatus::Error {
                    message: format!("Upload failed with status {}", res.status()),
                },
            );
            return;
        }
        Err(err) => {
            emit_status(
                app,
                CaptureStatus::Error {
                    message: format!("Upload failed: {err}"),
                },
            );
            return;
        }
    }

    let share_url = format!("{}{}", upload_api_base(), url);

    if let Err(err) = app.opener().open_url(share_url.clone(), None::<String>) {
        emit_status(
            app,
            CaptureStatus::Error {
                message: format!("Uploaded, but couldn't open the browser: {err}"),
            },
        );
        return;
    }

    emit_status(app, CaptureStatus::Done { share_url });
}

// ---------------------------------------------------------------------------
// Window video recording (ScreenCaptureKit sidecar)
// ---------------------------------------------------------------------------

#[derive(Default)]
struct RecInner {
    child: Option<std::process::Child>,
    output: Option<PathBuf>,
    toggle: Option<MenuItem<Wry>>,
}

#[derive(Default)]
struct RecState(Mutex<RecInner>);

const RECORD_LABEL: &str = "Record Window";
const STOP_LABEL: &str = "Stop Recording";

/// Locate the compiled `windowrec` sidecar in both bundled and dev layouts.
fn recorder_path() -> Option<PathBuf> {
    // Bundled app: Tauri copies the sidecar next to the main executable.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("windowrec");
            if p.exists() {
                return Some(p);
            }
        }
    }
    // Dev: the triple-suffixed binary lives in src-tauri/binaries/.
    let triple = format!("{}-apple-darwin", std::env::consts::ARCH);
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("windowrec-{triple}"));
    p.exists().then_some(p)
}

fn set_toggle_label(app: &AppHandle, label: &str) {
    let state = app.state::<RecState>();
    let inner = state.0.lock().unwrap();
    if let Some(item) = inner.toggle.as_ref() {
        let _ = item.set_text(label);
    }
}

fn is_recording(app: &AppHandle) -> bool {
    let state = app.state::<RecState>();
    let inner = state.0.lock().unwrap();
    inner.child.is_some()
}

#[tauri::command]
async fn start_recording(app: AppHandle) {
    if is_recording(&app) {
        return;
    }

    let Some(bin) = recorder_path() else {
        emit_status(
            &app,
            CaptureStatus::Error {
                message: "Window recorder is not available in this build.".to_string(),
            },
        );
        return;
    };

    let output = std::env::temp_dir().join(format!(
        "screenshot-app-{}.mp4",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));

    match std::process::Command::new(&bin).arg(&output).spawn() {
        Ok(child) => {
            let state = app.state::<RecState>();
            let mut inner = state.0.lock().unwrap();
            inner.child = Some(child);
            inner.output = Some(output);
            if let Some(item) = inner.toggle.as_ref() {
                let _ = item.set_text(STOP_LABEL);
            }
            drop(inner);
            emit_status(&app, CaptureStatus::Recording);
        }
        Err(err) => {
            emit_status(
                &app,
                CaptureStatus::Error {
                    message: format!("Failed to start recorder: {err}"),
                },
            );
        }
    }
}

#[tauri::command]
async fn stop_recording(app: AppHandle) {
    // Detach the running child + output path from shared state.
    let (child, output) = {
        let state = app.state::<RecState>();
        let mut inner = state.0.lock().unwrap();
        (inner.child.take(), inner.output.take())
    };
    set_toggle_label(&app, RECORD_LABEL);

    let (Some(child), Some(output)) = (child, output) else {
        return;
    };

    // Politely ask the recorder to finalize the MP4, then wait for it to flush.
    let pid = child.id() as i32;
    unsafe {
        libc::kill(pid, libc::SIGINT);
    }

    let wait = tauri::async_runtime::spawn_blocking(move || {
        let mut child = child;
        child.wait()
    })
    .await;

    match wait {
        Ok(Ok(_)) => {}
        _ => {
            emit_status(
                &app,
                CaptureStatus::Error {
                    message: "Recorder did not exit cleanly.".to_string(),
                },
            );
            let _ = std::fs::remove_file(&output);
            return;
        }
    }

    // No file (or empty) means the user cancelled the window picker.
    let bytes = match std::fs::read(&output) {
        Ok(bytes) if !bytes.is_empty() => bytes,
        _ => {
            let _ = std::fs::remove_file(&output);
            emit_status(&app, CaptureStatus::Cancelled);
            return;
        }
    };
    let _ = std::fs::remove_file(&output);

    upload_recording(&app, bytes).await;
}

fn toggle_recording(app: &AppHandle) {
    let app = app.clone();
    if is_recording(&app) {
        tauri::async_runtime::spawn(stop_recording(app));
    } else {
        tauri::async_runtime::spawn(start_recording(app));
    }
}

#[tauri::command]
async fn capture_now(app: AppHandle) {
    capture_and_share(app, CaptureMode::Region).await;
}

#[tauri::command]
async fn capture_window(app: AppHandle) {
    capture_and_share(app, CaptureMode::Window).await;
}

#[tauri::command]
async fn capture_screen(app: AppHandle) {
    capture_and_share(app, CaptureMode::Screen).await;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let global_shortcut_plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let app = app.clone();
                tauri::async_runtime::spawn(capture_and_share(app, CaptureMode::Region));
            }
        })
        .build();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(global_shortcut_plugin)
        .manage(RecState::default())
        .invoke_handler(tauri::generate_handler![
            capture_now,
            capture_window,
            capture_screen,
            start_recording,
            stop_recording
        ])
        .setup(|app| {
            app.global_shortcut().register(CAPTURE_SHORTCUT)?;

            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let region_item = MenuItem::with_id(app, "region", "Capture Region  ⌘⇧9", true, None::<&str>)?;
            let window_item = MenuItem::with_id(app, "window", "Capture Window", true, None::<&str>)?;
            let screen_item = MenuItem::with_id(app, "screen", "Capture Full Screen", true, None::<&str>)?;
            let record_item = MenuItem::with_id(app, "record", RECORD_LABEL, true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let separator2 = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit ScreenCapture", true, None::<&str>)?;

            let menu = Menu::with_items(
                app,
                &[
                    &region_item,
                    &window_item,
                    &screen_item,
                    &separator,
                    &record_item,
                    &separator2,
                    &quit_item,
                ],
            )?;

            // Keep a handle to the record item so we can flip its label.
            app.state::<RecState>().0.lock().unwrap().toggle = Some(record_item);

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                // macOS 26 (Tahoe) redesigned the menu bar; plain colored status
                // icons often fail to render. Our icon is a shaped, transparent
                // logo, so mark it as a template image — macOS then draws a clean
                // monochrome silhouette that shows reliably on the new menu bar.
                .icon_as_template(true)
                .menu(&menu)
                .tooltip("ScreenCapture")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "region" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(capture_and_share(app, CaptureMode::Region));
                    }
                    "window" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(capture_and_share(app, CaptureMode::Window));
                    }
                    "screen" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(capture_and_share(app, CaptureMode::Screen));
                    }
                    "record" => toggle_recording(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        let app = app.clone();
                        tauri::async_runtime::spawn(capture_and_share(app, CaptureMode::Region));
                    }
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
