mod loader;
mod native_host;
mod usercss;

use std::process::ExitCode;

const USAGE: &str = "\
usage: atelier <command>

  native-host   bridge between the browser extension and the daemon
                (started by the browser via native messaging)

Everything else in SPEC.md §13 is still to come.";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("native-host") => native_host::run(&args[1..]),
        Some("-h" | "--help" | "help") => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        Some(other) => {
            eprintln!("atelier: unknown command {other}\n\n{USAGE}");
            ExitCode::FAILURE
        }
        None => {
            eprintln!("{USAGE}");
            ExitCode::FAILURE
        }
    }
}
