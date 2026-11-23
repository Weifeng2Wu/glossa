use std::{
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
};
use tokio::process::Command as TokioCommand;

pub fn merge_search_paths(original: Option<OsString>, fallbacks: &[PathBuf]) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = original
        .as_deref()
        .map(std::env::split_paths)
        .into_iter()
        .flatten()
        .filter(|directory| !directory.as_os_str().is_empty())
        .collect();
    for directory in fallbacks {
        if directory.as_os_str().is_empty() {
            continue;
        }
        let already_present = if cfg!(windows) {
            let needle = directory.to_string_lossy().to_ascii_lowercase();
            paths
                .iter()
                .any(|existing| existing.to_string_lossy().to_ascii_lowercase() == needle)
        } else {
            paths.contains(directory)
        };
        if !already_present {
            paths.push(directory.clone());
        }
    }
    paths
}

#[cfg(any(windows, test))]
fn windows_cli_fallbacks(environment: impl Fn(&str) -> Option<OsString>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for (variable, directories) in [
        (
            "ProgramW6432",
            &["GitHub CLI", "WinGet/Links", "nodejs"][..],
        ),
        (
            "ProgramFiles",
            &["GitHub CLI", "WinGet/Links", "nodejs"][..],
        ),
        ("ProgramFiles(x86)", &["GitHub CLI", "nodejs"][..]),
        (
            "LOCALAPPDATA",
            &[
                "GitHub CLI",
                "Programs/GitHub CLI",
                "Microsoft/WinGet/Links",
                "Microsoft/WindowsApps",
                "nodejs",
                "pnpm",
                "Yarn/bin",
            ][..],
        ),
        ("APPDATA", &["npm", "fnm/current/bin"][..]),
        (
            "USERPROFILE",
            &[
                ".local/bin",
                ".cargo/bin",
                ".opencode/bin",
                ".volta/bin",
                ".bun/bin",
                "scoop/shims",
            ][..],
        ),
        ("SCOOP", &["shims"][..]),
        ("SCOOP_GLOBAL", &["shims"][..]),
        ("ChocolateyInstall", &["bin"][..]),
        ("ProgramData", &["chocolatey/bin", "scoop/shims"][..]),
    ] {
        if let Some(directory) = environment(variable).filter(|value| !value.is_empty()) {
            let directory = PathBuf::from(directory);
            paths.extend(directories.iter().map(|suffix| directory.join(suffix)));
        }
    }
    for variable in ["NVM_SYMLINK", "NVM_HOME"] {
        if let Some(directory) = environment(variable).filter(|value| !value.is_empty()) {
            paths.push(PathBuf::from(directory));
        }
    }
    paths
}

#[cfg(windows)]
fn windows_registry_paths() -> Vec<PathBuf> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    const HKEY_CURRENT_USER: isize = -2147483647; // 0x80000001
    const HKEY_LOCAL_MACHINE: isize = -2147483646; // 0x80000002
    const RRF_RT_REG_SZ: u32 = 0x00000002;
    const RRF_RT_REG_EXPAND_SZ: u32 = 0x00000004;
    const MAX_BYTES: u32 = 1024 * 1024;

    #[link(name = "advapi32")]
    extern "system" {
        fn RegGetValueW(
            hkey: isize,
            lp_sub_key: *const u16,
            lp_value: *const u16,
            dw_flags: u32,
            pdw_type: *mut u32,
            pv_data: *mut u8,
            pcb_data: *mut u32,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn ExpandEnvironmentStringsW(lp_src: *const u16, lp_dst: *mut u16, n_size: u32) -> u32;
    }

    fn to_wide(value: &str) -> Vec<u16> {
        OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn expand_wide(source: &[u16]) -> OsString {
        // SAFETY: source is NUL-terminated UTF-16; first call queries required buffer length.
        let required = unsafe { ExpandEnvironmentStringsW(source.as_ptr(), std::ptr::null_mut(), 0) };
        if required == 0 || required > MAX_BYTES / 2 {
            let trimmed = source.split(|&ch| ch == 0).next().unwrap_or(&[]);
            return OsString::from_wide(trimmed);
        }
        let mut buffer = vec![0u16; required as usize];
        // SAFETY: buffer has `required` u16 elements.
        let written = unsafe { ExpandEnvironmentStringsW(source.as_ptr(), buffer.as_mut_ptr(), required) };
        if written == 0 || written > required {
            let trimmed = source.split(|&ch| ch == 0).next().unwrap_or(&[]);
            return OsString::from_wide(trimmed);
        }
        let trimmed = buffer.split(|&ch| ch == 0).next().unwrap_or(&[]);
        OsString::from_wide(trimmed)
    }

    fn read_path(hkey: isize, subkey: &str) -> Option<OsString> {
        let subkey_wide = to_wide(subkey);
        let value_wide = to_wide("Path");
        let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ;
        let mut bytes: u32 = 0;
        // SAFETY: querying required byte length with null output buffer.
        let status = unsafe {
            RegGetValueW(
                hkey,
                subkey_wide.as_ptr(),
                value_wide.as_ptr(),
                flags,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut bytes,
            )
        };
        if status != 0 || bytes < 2 || bytes > MAX_BYTES {
            return None;
        }
        let mut buffer = vec![0u16; (bytes as usize + 1) / 2];
        // SAFETY: buffer holds at least `bytes` bytes.
        let status = unsafe {
            RegGetValueW(
                hkey,
                subkey_wide.as_ptr(),
                value_wide.as_ptr(),
                flags,
                std::ptr::null_mut(),
                buffer.as_mut_ptr() as *mut u8,
                &mut bytes,
            )
        };
        if status != 0 {
            return None;
        }
        if !buffer.ends_with(&[0]) {
            buffer.push(0);
        }
        Some(expand_wide(&buffer))
    }

    let mut paths = Vec::new();
    for (hkey, subkey) in [
        (HKEY_CURRENT_USER, "Environment"),
        (
            HKEY_LOCAL_MACHINE,
            "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
        ),
    ] {
        if let Some(raw) = read_path(hkey, subkey) {
            paths.extend(
                std::env::split_paths(&raw).filter(|entry| !entry.as_os_str().is_empty()),
            );
        }
    }
    paths
}

#[cfg(unix)]
fn unix_nvm_node_bins(home: &Path) -> Vec<PathBuf> {
    let versions_dir = home.join(".nvm/versions/node");
    let Ok(entries) = std::fs::read_dir(versions_dir) else {
        return Vec::new();
    };
    let mut bins: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok().map(|item| item.path().join("bin")))
        .filter(|path| path.is_dir())
        .collect();
    bins.sort_by(|a, b| b.cmp(a));
    bins
}

#[cfg(any(windows, test))]
pub fn resolve_cli_program_in_paths(program: &OsStr, paths: &[PathBuf]) -> PathBuf {
    let candidate_path = Path::new(program);
    if candidate_path.is_absolute() || candidate_path.components().count() > 1 {
        return candidate_path.to_path_buf();
    }
    let name = program.to_string_lossy();
    let has_extension = candidate_path.extension().is_some();
    let suffixes: &[&str] = if has_extension {
        &[""]
    } else {
        &[".exe", ".cmd", ".bat", ""]
    };
    for directory in paths {
        for suffix in suffixes {
            let candidate = directory.join(format!("{name}{suffix}"));
            if std::fs::metadata(&candidate).is_ok_and(|metadata| metadata.is_file()) {
                return candidate;
            }
        }
    }
    candidate_path.to_path_buf()
}

/// Desktop launches do not inherit Homebrew or user CLI directories from a terminal.
pub fn cli_search_paths() -> Vec<PathBuf> {
    let mut fallbacks = Vec::new();
    #[cfg(unix)]
    {
        fallbacks.extend(
            [
                "/opt/homebrew/bin",
                "/usr/local/bin",
                "/opt/local/bin",
                "/usr/bin",
                "/bin",
                "/usr/sbin",
                "/sbin",
                "/home/linuxbrew/.linuxbrew/bin",
            ]
            .map(PathBuf::from),
        );
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            for directory in [
                ".local/bin",
                ".cargo/bin",
                ".opencode/bin",
                ".npm-global/bin",
                ".npm/bin",
                ".volta/bin",
                ".bun/bin",
                ".yarn/bin",
                ".fnm/current/bin",
                ".gemini/antigravity/bin",
                "Library/pnpm",
                ".local/share/pnpm",
                ".asdf/shims",
                ".local/share/mise/shims",
                ".linuxbrew/bin",
            ] {
                fallbacks.push(home.join(directory));
            }
            fallbacks.extend(unix_nvm_node_bins(&home));
        }
    }
    #[cfg(windows)]
    {
        // Read fresh User + System PATH from the Windows Registry so tools installed
        // while Glossa or Explorer is already running are detected without restarting.
        fallbacks.extend(windows_registry_paths());
        fallbacks.extend(windows_cli_fallbacks(|variable| std::env::var_os(variable)));
    }
    for variable in ["NVM_BIN", "PNPM_HOME"] {
        if let Some(directory) = std::env::var_os(variable) {
            fallbacks.push(PathBuf::from(directory));
        }
    }
    merge_search_paths(std::env::var_os("PATH"), &fallbacks)
}

pub fn cli_environment_path() -> OsString {
    std::env::join_paths(cli_search_paths())
        .unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

pub fn cli_command(program: impl AsRef<OsStr>) -> TokioCommand {
    let paths = cli_search_paths();
    #[cfg(windows)]
    let resolved = resolve_cli_program_in_paths(program.as_ref(), &paths);
    #[cfg(not(windows))]
    let resolved = program.as_ref();
    let mut cmd = command(resolved);
    cmd.env(
        "PATH",
        std::env::join_paths(&paths)
            .unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default()),
    );
    cmd
}

/// Windows CREATE_NO_WINDOW flag to hide console windows
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Extension trait for TokioCommand to hide console windows on Windows
pub trait CommandExt {
    /// Configure the command to hide console window on Windows
    fn hide_window(&mut self) -> &mut Self;
}

impl CommandExt for TokioCommand {
    #[cfg(target_os = "windows")]
    fn hide_window(&mut self) -> &mut Self {
        self.creation_flags(CREATE_NO_WINDOW);
        self
    }

    #[cfg(not(target_os = "windows"))]
    fn hide_window(&mut self) -> &mut Self {
        self
    }
}

/// Create a new TokioCommand with hidden window on Windows
pub fn command(program: impl AsRef<OsStr>) -> TokioCommand {
    let mut cmd = TokioCommand::new(program);
    cmd.hide_window();
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_paths_include_user_installs_and_custom_package_managers() {
        let paths = windows_cli_fallbacks(|variable| match variable {
            "LOCALAPPDATA" => Some("local-app-data".into()),
            "APPDATA" => Some("app-data".into()),
            "ProgramW6432" => Some("program-files".into()),
            "SCOOP" => Some("custom-scoop".into()),
            "SCOOP_GLOBAL" => Some("global-scoop".into()),
            "ChocolateyInstall" => Some("custom-chocolatey".into()),
            "ProgramData" => Some("program-data".into()),
            "NVM_SYMLINK" => Some("nvm-symlink".into()),
            _ => None,
        });
        for expected in [
            "local-app-data/Programs/GitHub CLI",
            "local-app-data/Microsoft/WinGet/Links",
            "local-app-data/pnpm",
            "local-app-data/Yarn/bin",
            "app-data/npm",
            "app-data/fnm/current/bin",
            "program-files/GitHub CLI",
            "program-files/WinGet/Links",
            "custom-scoop/shims",
            "global-scoop/shims",
            "custom-chocolatey/bin",
            "program-data/chocolatey/bin",
            "nvm-symlink",
        ] {
            assert!(paths.contains(&PathBuf::from(expected)), "{expected}");
        }
    }

    #[test]
    fn windows_paths_ignore_missing_or_empty_environment_values() {
        assert!(windows_cli_fallbacks(|_| None).is_empty());
        assert!(windows_cli_fallbacks(|_| Some(OsString::new())).is_empty());
    }

    #[test]
    fn resolves_cli_program_with_windows_extensions_and_skips_directories() {
        let directory = tempfile::tempdir().unwrap();
        let preferred = directory.path().join("first");
        let fallback = directory.path().join("second");
        std::fs::create_dir_all(preferred.join("gh.exe")).unwrap();
        std::fs::create_dir_all(&fallback).unwrap();
        std::fs::write(fallback.join("gh.cmd"), b"fixture").unwrap();
        let paths = vec![preferred.clone(), fallback.clone()];
        assert_eq!(
            resolve_cli_program_in_paths(OsStr::new("gh"), &paths),
            fallback.join("gh.cmd")
        );

        std::fs::write(preferred.join("npm.cmd"), b"fixture").unwrap();
        assert_eq!(
            resolve_cli_program_in_paths(OsStr::new("npm.cmd"), &paths),
            preferred.join("npm.cmd")
        );

        let explicit = fallback.join("custom.exe");
        assert_eq!(
            resolve_cli_program_in_paths(explicit.as_os_str(), &paths),
            explicit
        );
    }
}
