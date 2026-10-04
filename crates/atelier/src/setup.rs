//! `atelier setup`: registering the native-messaging host with the user's
//! browsers (SPEC §14), and optionally choosing the default owned directory.

use crate::paths;
use serde_json::json;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

/// Only the dev build exists so far; it must match extension/build.ts.
const HOST_NAME: &str = "atelier_dev";
const EXTENSION_ID: &str = "atelier-dev@atelier.invalid";

/// Firefox-family browsers and where they look for per-user host manifests.
const BROWSERS: &[(&str, &str)] = &[
    ("Firefox", ".mozilla"),
    ("LibreWolf", ".librewolf"),
    ("Waterfox", ".waterfox"),
];

pub fn run(dir: Option<&str>) -> ExitCode {
    match setup(dir) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("atelier setup: {e}");
            ExitCode::FAILURE
        }
    }
}

fn setup(dir: Option<&str>) -> io::Result<()> {
    let exe = std::env::current_exe()?.canonicalize()?;
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::other("HOME isn't set"))?;

    // Firefox always, plus any other browser whose profile directory exists.
    let mut wrote = Vec::new();
    for (i, (browser, dot_dir)) in BROWSERS.iter().enumerate() {
        if i > 0 && !home.join(dot_dir).is_dir() {
            continue;
        }
        let manifest = home
            .join(dot_dir)
            .join("native-messaging-hosts")
            .join(format!("{HOST_NAME}.json"));
        write_manifest(&manifest, &exe)?;
        wrote.push(format!("{browser}: {}", manifest.display()));
    }
    println!("registered the native host ({}) for:", exe.display());
    for w in &wrote {
        println!("  {w}");
    }

    if let Some(dir) = dir {
        let dir = Path::new(dir).canonicalize().map_err(|e| {
            io::Error::new(
                e.kind(),
                format!("{dir}: {e}; create it first with `atelier --dir {dir} init`"),
            )
        })?;
        set_config("atelier_dir", &dir.display().to_string())?;
        println!(
            "default owned directory: {} (in {})",
            dir.display(),
            paths::config_path().display()
        );
    }

    println!(
        "\nNext: load the extension. Until atelier has signed builds, use about:debugging →\n\
         This Firefox → Load Temporary Add-on, and pick extension/dist/manifest.json\n\
         (temporary add-ons are removed when Firefox restarts). Then allow user scripts\n\
         when atelier asks."
    );
    if !exe.starts_with("/nix/store") && exe.components().any(|c| c.as_os_str() == "target") {
        println!(
            "\nThe manifest points at this build ({}), so rebuilding updates the host,\n\
             and moving or cleaning the build breaks it until you run setup again.",
            exe.display()
        );
    }
    Ok(())
}

fn write_manifest(path: &Path, exe: &Path) -> io::Result<()> {
    let manifest = json!({
        "name": HOST_NAME,
        "description": "atelier native host",
        "path": exe,
        "type": "stdio",
        "allowed_extensions": [EXTENSION_ID],
    });
    fs::create_dir_all(path.parent().expect("manifest has a parent"))?;
    fs::write(path, serde_json::to_string_pretty(&manifest)? + "\n")
}

/// Sets one key in config.toml, keeping everything else in it.
fn set_config(key: &str, value: &str) -> io::Result<()> {
    let path = paths::config_path();
    let mut table: toml::Table = match fs::read_to_string(&path) {
        Ok(text) => toml::from_str(&text)
            .map_err(|e| io::Error::other(format!("{}: {e}", path.display())))?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => toml::Table::new(),
        Err(e) => return Err(e),
    };
    table.insert(key.to_string(), toml::Value::String(value.to_string()));
    fs::create_dir_all(path.parent().expect("config has a parent"))?;
    fs::write(&path, toml::to_string(&table).map_err(io::Error::other)?)
}
