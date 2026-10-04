//! `atelier setup` against a temporary home directory.

use std::process::Command;

#[test]
fn registers_host_and_sets_default_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    let owned = tmp.path().join("owned");
    std::fs::create_dir_all(home.join(".librewolf")).unwrap();
    std::fs::create_dir_all(&owned).unwrap();
    let atelier = || {
        let mut c = Command::new(env!("CARGO_BIN_EXE_atelier"));
        c.env_clear()
            .env("HOME", &home)
            .env("XDG_CONFIG_HOME", home.join(".config"));
        c
    };

    let out = atelier()
        .args(["setup", "--dir"])
        .arg(&owned)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );

    for browser in [".mozilla", ".librewolf"] {
        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(
                home.join(browser)
                    .join("native-messaging-hosts/atelier_dev.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            manifest["allowed_extensions"][0],
            "atelier-dev@atelier.invalid"
        );
        assert_eq!(
            manifest["path"],
            std::fs::canonicalize(env!("CARGO_BIN_EXE_atelier"))
                .unwrap()
                .to_str()
                .unwrap()
        );
    }
    assert!(
        !home.join(".waterfox").exists(),
        "browsers that aren't installed are skipped"
    );

    // The config now names the owned directory, so commands find it without --dir.
    let status = atelier().arg("status").output().unwrap();
    let text = String::from_utf8_lossy(&status.stdout);
    assert!(
        text.contains(owned.canonicalize().unwrap().to_str().unwrap()),
        "{text}"
    );
}
