use std::collections::HashSet;
use std::fs::{create_dir_all, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use tauri::Manager;

use crate::paths;

const DEFAULT_PORT: u16 = 17899;
const START_TIMEOUT: Duration = Duration::from_secs(20);

/// The workbench child process owned by the app.
pub struct Workbench {
    pub url: String,
    child: Child,
    #[cfg(unix)]
    process_group: i32,
}

fn prepare_environment(command: &mut Command, app_paths: &paths::Paths) {
    let mut directories: Vec<PathBuf> = Vec::new();
    if let Some(runtime) = app_paths.node.parent() {
        directories.push(runtime.to_path_buf());
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        for relative in [".local/bin", "bin", ".cargo/bin"] {
            directories.push(home.join(relative));
        }
    }
    directories.push(PathBuf::from("/opt/homebrew/bin"));
    directories.push(PathBuf::from("/usr/local/bin"));
    if let Some(path) = std::env::var_os("PATH") {
        directories.extend(std::env::split_paths(&path));
    }

    let mut seen = HashSet::new();
    directories.retain(|directory| seen.insert(directory.clone()));
    if let Ok(path) = std::env::join_paths(&directories) {
        command.env("PATH", path);
    }
    for directory in &directories {
        let candidate = directory.join("agent-desktop");
        if candidate.is_file() {
            command.env("CUEKEEPER_AGENT_DESKTOP", candidate);
            break;
        }
    }
}

/// The per-user log directory. Tauri gives the platform convention; the
/// fallback keeps a broken path resolver from hiding the workbench log.
pub fn log_directory(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(directory) = app.path().app_log_dir() {
        return directory;
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("Library")
        .join("Logs")
        .join("CueKeeper")
}

pub fn start(app: &tauri::AppHandle) -> Result<Workbench, String> {
    let paths = paths::resolve(app)?;
    let log_directory = log_directory(app);
    create_dir_all(&log_directory)
        .map_err(|error| format!("无法创建日志目录 {}：{error}", log_directory.display()))?;
    let log_path = log_directory.join("workbench.log");
    let mut log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| format!("无法打开日志 {}：{error}", log_path.display()))?;
    let _ = writeln!(
        log,
        "\n=== CueKeeper {} ===\nroot={} node={}",
        env!("CARGO_PKG_VERSION"),
        paths.root.display(),
        paths.node.display()
    );

    let port = std::env::var("CUEKEEPER_WORKBENCH_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);

    let mut command = Command::new(&paths.node);
    command
        .arg(&paths.cli)
        .arg("workbench")
        .arg("--port")
        .arg(port.to_string())
        .current_dir(&paths.root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(bundle) = &paths.bundle {
        // The guide uses this to name the app bundle that owns the TCC grant.
        command.env("CUEKEEPER_APP_PATH", bundle);
    }
    let capture_app = paths.root.join("helpers").join("CueKeeper Capture.app");
    let capture_binary = capture_app
        .join("Contents")
        .join("MacOS")
        .join("cuekeeper-capture");
    if capture_binary.is_file() {
        // The nested capture app owns Accessibility and Input Monitoring; the
        // shell and its Node engine stay permission-free.
        command.env("CUEKEEPER_RECORDER", &capture_binary);
        command.env("CUEKEEPER_CAPTURE_APP", &capture_app);
    }
    prepare_environment(&mut command, &paths);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // A process group lets a quit stop the recorder the workbench spawned.
        command.process_group(0);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动内置 Node {}：{error}", paths.node.display()))?;
    let pid = child.id() as i32;
    let stdout = child.stdout.take().ok_or("工作台没有 stdout")?;
    let stderr = child.stderr.take().ok_or("工作台没有 stderr")?;
    let (sender, receiver) = mpsc::channel::<Result<String, String>>();

    let mut stdout_log = log
        .try_clone()
        .map_err(|error| format!("无法复制日志句柄：{error}"))?;
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let _ = writeln!(stdout_log, "{line}");
            let trimmed = line.trim();
            if trimmed.starts_with("http://127.0.0.1:") {
                let _ = sender.send(Ok(trimmed.to_string()));
            }
        }
        let _ = sender.send(Err("工作台进程已退出".into()));
    });

    let mut stderr_log = log
        .try_clone()
        .map_err(|error| format!("无法复制日志句柄：{error}"))?;
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            let _ = writeln!(stderr_log, "{line}");
        }
    });

    let deadline = Instant::now() + START_TIMEOUT;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        match receiver.recv_timeout(left.min(Duration::from_millis(200))) {
            Ok(Ok(url)) => {
                return Ok(Workbench {
                    url,
                    child,
                    #[cfg(unix)]
                    process_group: pid,
                });
            }
            Ok(Err(message)) => {
                return Err(format!(
                    "{message}。日志：{}",
                    log_path.display()
                ));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Ok(Some(status)) = child.try_wait() {
                    return Err(format!(
                        "工作台启动失败（{status}）。日志：{}",
                        log_path.display()
                    ));
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    stop_child(&mut child, pid);
    Err(format!(
        "工作台启动超时。日志：{}",
        log_path.display()
    ))
}

impl Workbench {
    pub fn stop(&mut self) {
        let pid = self.pid();
        stop_child(&mut self.child, pid);
    }

    #[cfg(unix)]
    fn pid(&self) -> i32 {
        self.process_group
    }

    #[cfg(not(unix))]
    fn pid(&self) -> i32 {
        self.child.id() as i32
    }
}

impl Drop for Workbench {
    fn drop(&mut self) {
        self.stop();
    }
}

fn stop_child(child: &mut Child, pid: i32) {
    #[cfg(unix)]
    unsafe {
        // Negative pid addresses the whole group: Node and the recorder it
        // started. SIGTERM lets the workbench cancel an active recording.
        libc::kill(-pid, libc::SIGTERM);
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        let _ = child.kill();
    }

    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => break,
        }
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}
