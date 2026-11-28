use std::path::{Path, PathBuf};

use tauri::Manager;

/// The files the shell needs. The release layout keeps the Node runtime and the
/// compiled CLI under one root so the app can start without a system Node.
pub struct Paths {
    pub root: PathBuf,
    pub node: PathBuf,
    pub cli: PathBuf,
    pub bundle: Option<PathBuf>,
}

pub fn resolve(app: &tauri::AppHandle) -> Result<Paths, String> {
    let bundle = bundle_path();

    // Tests and local development can point the shell at a release directory
    // or a checkout without rebuilding the bundle.
    if let Some(root) = std::env::var_os("CUEKEEPER_APP_ROOT").map(PathBuf::from) {
        return from_root(root, bundle);
    }

    if let Ok(resources) = app.path().resource_dir() {
        let root = resources.join("cuekeeper");
        if root.join("lib").join("dist").join("cli.js").is_file() {
            return from_root(root, bundle);
        }
    }

    let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| "无法定位 CueKeeper 安装目录".to_string())?
        .to_path_buf();
    if repo.join("dist").join("cli.js").is_file() {
        return Ok(Paths {
            node: find_node()?,
            cli: repo.join("dist").join("cli.js"),
            root: repo,
            bundle,
        });
    }

    Err("找不到内置工作台；请用 npm run app:package 重新打包".into())
}

fn from_root(root: PathBuf, bundle: Option<PathBuf>) -> Result<Paths, String> {
    let cli = root.join("lib").join("dist").join("cli.js");
    if !cli.is_file() {
        return Err(format!("工作台文件缺失：{}", cli.display()));
    }
    let bundled_node = root.join("runtime").join("node");
    let node = if bundled_node.is_file() {
        bundled_node
    } else {
        find_node()?
    };
    Ok(Paths { root, node, cli, bundle })
}

fn find_node() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("CUEKEEPER_NODE") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    for directory in std::env::split_paths(&path) {
        let candidate = directory.join("node");
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err("找不到 Node 运行时".into())
}

#[cfg(target_os = "macos")]
fn bundle_path() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let contents = executable.parent()?.parent()?;
    if contents.file_name()?.to_str()? != "Contents" {
        return None;
    }
    let bundle = contents.parent()?;
    if bundle.extension()?.to_str()? != "app" {
        return None;
    }
    Some(bundle.to_path_buf())
}

#[cfg(not(target_os = "macos"))]
fn bundle_path() -> Option<PathBuf> {
    None
}
