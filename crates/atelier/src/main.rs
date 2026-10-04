mod cli;
mod daemon;
mod loader;
mod mcp;
mod native_host;
mod paths;
mod session;
mod setup;
mod tasks;
mod usercss;
mod wire;

use std::process::ExitCode;

const USAGE: &str = "\
usage: atelier [--dir DIR] <command>

  init [--theme NAME]   create an owned directory (default theme name: main)
  setup [--dir DIR]     register the native-messaging host with Firefox-family
                        browsers; with --dir, also make DIR the default owned directory
  status                daemon, theme, styles and problems
  lint                  load the owned directory and report problems
  match URL             which styles apply to URL
  task create [--kind KIND] [--service S] [--origin URL] [--note TEXT] DESCRIPTION
  task list [--state STATE] | show ID | abandon ID [REASON]
  task claim [ID] [--session NAME] | submit ID [--session NAME] SUMMARY
                        tasks (SPEC §8)
  undo [SEQ]            undo a landing (default: the most recent)
  session start [--force]
                        start an agent session with [session] command from config.toml
  journal               landings and undos, newest first
  browser METHOD [JSON] [--out FILE]
                        call a browser tool through the daemon (see extension/src/tools.ts)
  mcp                   MCP server (stdio) with browser tools for agents
  daemon                serve the owned directory (normally started for you)
  native-host           bridge for the browser extension (started by the browser)

The owned directory is --dir, else $ATELIER_DIR, else atelier_dir in
$XDG_CONFIG_HOME/atelier/config.toml, else $XDG_DATA_HOME/atelier.";

fn main() -> ExitCode {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let dir = take_option(&mut args, "--dir");
    let Some(command) = (!args.is_empty()).then(|| args.remove(0)) else {
        eprintln!("{USAGE}");
        return ExitCode::FAILURE;
    };
    // One-shot commands die quietly when their output is closed early
    // (`atelier journal | head`), as command-line tools do. Long-running ones
    // keep Rust's default of ignoring SIGPIPE, so a closed socket or pipe is
    // an error they handle, not the end of the process.
    if !matches!(command.as_str(), "daemon" | "native-host" | "mcp") && !command.ends_with(".json")
    {
        // SAFETY: restoring the default disposition of a signal, before any threads start.
        unsafe {
            libc::signal(libc::SIGPIPE, libc::SIG_DFL);
        }
    }
    match command.as_str() {
        // Firefox runs the manifest's path with the manifest's own path and the
        // extension ID as arguments, so a first argument ending in .json means
        // we were started as the native host.
        manifest if manifest.ends_with(".json") => {
            args.insert(0, command.clone());
            native_host::run(&args)
        }
        "native-host" => native_host::run(&args),
        "setup" => setup::run(dir.as_deref()),
        "daemon" => daemon::run(dir.as_deref()),
        "mcp" => mcp::run(dir.as_deref()),
        "status" => cli::status(dir.as_deref()),
        "lint" => cli::lint(dir.as_deref()),
        "task" | "undo" | "journal" | "session" => {
            args.insert(0, command.clone());
            cli::tasks(dir.as_deref(), &args)
        }
        "browser" => {
            let out = take_option(&mut args, "--out");
            match args.first() {
                Some(m) => cli::browser(
                    dir.as_deref(),
                    m,
                    args.get(1).map(String::as_str),
                    out.as_deref(),
                ),
                None => {
                    eprintln!("usage: atelier browser METHOD [JSON] [--out FILE]");
                    ExitCode::FAILURE
                }
            }
        }
        "match" => match args.first() {
            Some(url) => cli::match_url(dir.as_deref(), url),
            None => {
                eprintln!("usage: atelier match URL");
                ExitCode::FAILURE
            }
        },
        "init" => {
            let theme = take_option(&mut args, "--theme").unwrap_or_else(|| "main".into());
            cli::init(dir.as_deref(), &theme)
        }
        "-h" | "--help" | "help" => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        other => {
            eprintln!("atelier: unknown command {other}\n\n{USAGE}");
            ExitCode::FAILURE
        }
    }
}

/// Removes `name VALUE` from `args` wherever it appears, returning VALUE.
fn take_option(args: &mut Vec<String>, name: &str) -> Option<String> {
    let i = args.iter().position(|a| a == name)?;
    args.remove(i);
    (i < args.len()).then(|| args.remove(i))
}
