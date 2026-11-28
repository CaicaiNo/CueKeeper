use std::path::Path;

/// Open one of the two privacy panes. The id is fixed by the caller; no URL or
/// command ever comes from the web page.
pub fn open_pane(id: &str) {
    #[cfg(target_os = "macos")]
    {
        let pane = match id {
            "accessibility" => "Privacy_Accessibility",
            "input-monitoring" => "Privacy_ListenEvent",
            _ => return,
        };
        let _ = std::process::Command::new("/usr/bin/open")
            .arg(format!(
                "x-apple.systempreferences:com.apple.preference.security?{pane}"
            ))
            .spawn();
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = id;
    }
}

pub fn open_path(path: &Path) {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("/usr/bin/open").arg(path).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(path).spawn();
    }
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("explorer").arg(path).spawn();
    }
}

/// Show a path in Finder with the item selected, so an app bundle can be
/// dragged into the Privacy lists.
pub fn reveal_path(path: &Path) {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("/usr/bin/open")
            .arg("-R")
            .arg(path)
            .spawn();
    }
    #[cfg(not(target_os = "macos"))]
    {
        open_path(path);
    }
}
