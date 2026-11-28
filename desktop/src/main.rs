#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod paths;
mod permissions;
mod server;

use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

struct AppState {
    server: Mutex<Option<server::Workbench>>,
    log_dir: std::path::PathBuf,
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let log_dir = server::log_directory(app.handle());
            let _ = std::fs::create_dir_all(&log_dir);
            app.manage(AppState {
                server: Mutex::new(None),
                log_dir: log_dir.clone(),
            });

            install_menu(app)?;

            // Start the bundled workbench before creating the window. Loading
            // the local URL directly avoids a custom-scheme-to-http navigation
            // that can leave the loading page spinning on macOS.
            let (target, startup_error) = match server::start(app.handle()) {
                Ok(workbench) => match workbench.url.parse::<tauri::Url>() {
                    Ok(url) => {
                        if let Some(state) = app.try_state::<AppState>() {
                            *state.server.lock().unwrap() = Some(workbench);
                        }
                        (WebviewUrl::External(url), None)
                    }
                    Err(error) => {
                        drop(workbench);
                        (
                            WebviewUrl::App("index.html".into()),
                            Some(format!("工作台地址无效：{error}")),
                        )
                    }
                },
                Err(error) => (WebviewUrl::App("index.html".into()), Some(error)),
            };

            let window = WebviewWindowBuilder::new(app, "main", target)
                .title("CueKeeper")
                .inner_size(1280.0, 860.0)
                .min_inner_size(980.0, 640.0)
                .center()
                .on_navigation(|url| allowed_navigation(url))
                .build()?;
            window.show()?;
            window.set_focus()?;
            if let Some(error) = startup_error {
                show_error(app.handle(), &error);
            }

            // Ask once per app install, not on every launch. A missed prompt
            // leaves the guide and the menu as the explicit way back in.
            let config_dir = app.path().app_config_dir().unwrap_or_else(|_| log_dir.clone());
            let _ = std::fs::create_dir_all(&config_dir);
            let prompt_marker = config_dir.join("permission-requested");
            if !prompt_marker.exists() {
                let _ = std::fs::write(&prompt_marker, b"1");
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(1600));
                    request_recorder(&handle);
                });
            }

            Ok(())
        })
        .on_menu_event(|app, event| menu_event(app, event.id().as_ref()))
        .build(tauri::generate_context!())
        .expect("error while building CueKeeper");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<AppState>() {
                if let Some(mut workbench) = state.server.lock().unwrap().take() {
                    workbench.stop();
                }
            }
        }
    });
}

fn install_menu(app: &tauri::App) -> tauri::Result<()> {
    let request = MenuItemBuilder::with_id("request_permissions", "请求录制权限").build(app)?;
    let accessibility =
        MenuItemBuilder::with_id("open_accessibility", "打开辅助功能设置").build(app)?;
    let input = MenuItemBuilder::with_id("open_input_monitoring", "打开输入监控设置").build(app)?;
    let show_capture =
        MenuItemBuilder::with_id("show_capture", "在 Finder 中显示录制器").build(app)?;
    let guide = MenuItemBuilder::with_id("open_guide", "使用引导").build(app)?;
    let reload = MenuItemBuilder::with_id("reload", "重新加载工作台").build(app)?;
    let logs = MenuItemBuilder::with_id("open_logs", "打开日志目录").build(app)?;
    let show = MenuItemBuilder::with_id("open_workbench", "显示工作台").build(app)?;

    let app_menu = SubmenuBuilder::new(app, "CueKeeper")
        .about_with_text("关于 CueKeeper", None)
        .separator()
        .item(&request)
        .item(&show_capture)
        .item(&accessibility)
        .item(&input)
        .separator()
        .services_with_text("服务")
        .separator()
        .hide_with_text("隐藏 CueKeeper")
        .hide_others_with_text("隐藏其他")
        .show_all_with_text("显示全部")
        .separator()
        .quit_with_text("退出 CueKeeper")
        .build()?;
    let edit_menu = SubmenuBuilder::new(app, "编辑")
        .undo_with_text("撤销")
        .redo_with_text("重做")
        .separator()
        .cut_with_text("剪切")
        .copy_with_text("复制")
        .paste_with_text("粘贴")
        .select_all_with_text("全选")
        .build()?;
    let view_menu = SubmenuBuilder::new(app, "视图")
        .item(&show)
        .item(&guide)
        .item(&reload)
        .separator()
        .item(&logs)
        .separator()
        .fullscreen_with_text("进入全屏")
        .build()?;
    let window_menu = SubmenuBuilder::new(app, "窗口")
        .minimize_with_text("最小化")
        .maximize_with_text("缩放")
        .separator()
        .close_window_with_text("关闭窗口")
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu, &view_menu, &window_menu])
        .build()?;
    let _ = app.set_menu(menu)?;
    Ok(())
}

fn menu_event(app: &tauri::AppHandle, id: &str) {
    match id {
        "request_permissions" => request_recorder(app),
        "show_capture" => reveal_capture(app),
        "open_accessibility" => permissions::open_pane("accessibility"),
        "open_input_monitoring" => permissions::open_pane("input-monitoring"),
        "open_guide" => eval(app, "document.getElementById('guide-button')?.click()"),
        "reload" => eval(app, "location.reload()"),
        "open_logs" => {
            if let Some(state) = app.try_state::<AppState>() {
                permissions::open_path(&state.log_dir);
            }
        }
        "open_workbench" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
        _ => {}
    }
}

fn request_recorder(app: &tauri::AppHandle) {
    if let Ok(paths) = paths::resolve(app) {
        let capture_app = paths.root.join("helpers").join("CueKeeper Capture.app");
        if capture_app.is_dir() {
            // Launch the nested app through LaunchServices so TCC attributes
            // the prompt to CueKeeper Capture, not to the shell.
            let _ = std::process::Command::new("/usr/bin/open")
                .arg("-a")
                .arg(&capture_app)
                .arg("--args")
                .arg("--request-permissions")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn();
            return;
        }
        let recorder = paths.root.join("lib").join("dist").join("cuekeeper-capture");
        let _ = std::process::Command::new(recorder)
            .arg("--request-permissions")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
}

fn reveal_capture(app: &tauri::AppHandle) {
    if let Ok(paths) = paths::resolve(app) {
        let capture_app = paths.root.join("helpers").join("CueKeeper Capture.app");
        let target = if capture_app.is_dir() {
            capture_app
        } else {
            paths.root.join("lib").join("dist").join("cuekeeper-capture")
        };
        permissions::reveal_path(&target);
    }
}

fn eval(app: &tauri::AppHandle, script: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(script);
    }
}

fn show_error(app: &tauri::AppHandle, message: &str) {
    let encoded = serde_json::to_string(message).unwrap_or_else(|_| "\"工作台启动失败\"".into());
    eval(app, &format!("window.cuekeeperError({encoded})"));
}

fn allowed_navigation(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" | "about" => true,
        // Tauri's bundled page uses tauri.localhost on some platforms; the
        // workbench itself is always the local Node listener.
        "http" => matches!(
            url.host_str(),
            Some("127.0.0.1") | Some("localhost") | Some("tauri.localhost")
        ),
        "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}
