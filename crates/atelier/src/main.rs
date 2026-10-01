mod cli;
mod daemon;
mod loader;
mod native_host;
mod paths;
mod usercss;
mod wire;

use std::process::ExitCode;

const USAGE: &str = "\
usage: atelier [--dir DIR] <command>

  init [--theme NAME]   create an owned directory (default theme name: main)
  status                daemon, theme, styles and problems
  lint                  load the owned directory and report problems
  match URL             which styles apply to URL
  daemon                serve the owned directory (normally started for you)
  native-host           bridge for the browser extension (started by the browser)

The owned directory is --dir, else $ATELIER_DIR, else $XDG_DATA_HOME/atelier.";

fn main() -> ExitCode {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let dir = take_option(&mut args, "--dir");
    let Some(command) = (!args.is_empty()).then(|| args.remove(0)) else {
        eprintln!("{USAGE}");
        return ExitCode::FAILURE;
    };
    match command.as_str() {
        // Firefox passes the host's manifest path and the extension ID.
        "native-host" => native_host::run(&args),
        "daemon" => daemon::run(dir.as_deref()),
        "status" => cli::status(dir.as_deref()),
        "lint" => cli::lint(dir.as_deref()),
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
