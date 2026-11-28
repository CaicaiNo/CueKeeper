use std::path::Path;

/// Request the two macOS grants the recorder needs. Accessibility uses the
/// AX prompt API; Input Monitoring uses the IOHID listen-event request. Both
/// calls add this app bundle to the matching System Settings list.
#[cfg(target_os = "macos")]
pub fn request() -> (bool, bool) {
    use macos_accessibility_client::accessibility::{
        application_is_trusted, application_is_trusted_with_prompt,
    };

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOHIDCheckAccess(request: u32) -> u32;
        fn IOHIDRequestAccess(request: u32) -> u8;
    }

    // kIOHIDRequestTypeListenEvent.
    const LISTEN_EVENT: u32 = 1;

    let mut accessibility = application_is_trusted();
    if !accessibility {
        application_is_trusted_with_prompt();
        accessibility = application_is_trusted();
    }

    let mut input_monitoring = unsafe { IOHIDCheckAccess(LISTEN_EVENT) } == 0;
    if !input_monitoring {
        unsafe {
            IOHIDRequestAccess(LISTEN_EVENT);
        }
        input_monitoring = unsafe { IOHIDCheckAccess(LISTEN_EVENT) } == 0;
    }

    (accessibility, input_monitoring)
}

#[cfg(not(target_os = "macos"))]
pub fn request() -> (bool, bool) {
    (true, true)
}

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
