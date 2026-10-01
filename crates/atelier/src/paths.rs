//! Where things live (SPEC §4, §7).

use sha2::{Digest, Sha256};
use std::io;
use std::path::{Path, PathBuf};

fn xdg(var: &str, fallback_under_home: &str) -> PathBuf {
    match std::env::var_os(var) {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => home().join(fallback_under_home),
    }
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// The owned directory: `explicit`, else `$ATELIER_DIR`, else `$XDG_DATA_HOME/atelier`.
/// Not canonicalized, and not required to exist.
pub fn atelier_dir(explicit: Option<&str>) -> PathBuf {
    if let Some(d) = explicit {
        return PathBuf::from(d);
    }
    match std::env::var_os("ATELIER_DIR") {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => xdg("XDG_DATA_HOME", ".local/share").join("atelier"),
    }
}

/// [`atelier_dir`], canonicalized. Errors if it doesn't exist.
pub fn resolve_dir(explicit: Option<&str>) -> io::Result<PathBuf> {
    let dir = atelier_dir(explicit);
    dir.canonicalize().map_err(|e| {
        io::Error::new(
            e.kind(),
            format!(
                "owned directory {} isn't usable ({e}); create one with `atelier init`",
                dir.display()
            ),
        )
    })
}

/// A short stable identifier for an owned directory, from its canonical path.
pub fn dir_id(dir: &Path) -> String {
    let digest = Sha256::digest(dir.as_os_str().as_encoded_bytes());
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

pub fn runtime_dir() -> PathBuf {
    match std::env::var_os("XDG_RUNTIME_DIR") {
        Some(d) if !d.is_empty() => PathBuf::from(d).join("atelier"),
        _ => std::env::temp_dir().join(format!("atelier-{}", whoami())),
    }
}

fn whoami() -> String {
    std::env::var("USER").unwrap_or_else(|_| "user".into())
}

pub fn socket_path(dir: &Path) -> PathBuf {
    runtime_dir().join(format!("{}.sock", dir_id(dir)))
}

pub fn state_root() -> PathBuf {
    xdg("XDG_STATE_HOME", ".local/state").join("atelier")
}

/// Runtime state for one owned directory (SPEC §7).
pub fn state_dir(dir: &Path) -> PathBuf {
    state_root().join(dir_id(dir))
}

pub fn config_dir() -> PathBuf {
    xdg("XDG_CONFIG_HOME", ".config").join("atelier")
}

/// Values for UserCSS `@var`s (SPEC §5.4).
pub fn vars_path() -> PathBuf {
    config_dir().join("vars.json")
}

/// Unix socket paths are limited to 107 bytes. Explains what to do if
/// `socket` is too long.
pub fn check_socket_path(socket: &Path) -> io::Result<()> {
    let len = socket.as_os_str().len();
    if len > 107 {
        return Err(io::Error::other(format!(
            "socket path {} is {len} bytes, longer than unix sockets allow (107); set XDG_RUNTIME_DIR to a shorter directory",
            socket.display()
        )));
    }
    Ok(())
}
