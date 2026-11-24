#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--check-portable-init") {
        match bookreader_lib::self_test::check_portable_init() {
            Ok(()) => std::process::exit(0),
            Err(err) => {
                eprintln!("PORTABLE-INIT FAILED: {err}");
                std::process::exit(1);
            }
        }
    }

    let self_test = args.iter().any(|a| a == "--self-test" || a == "--self-test-live-tts");
    let live_tts = args.iter().any(|a| a == "--self-test-live-tts");

    if self_test {
        match bookreader_lib::self_test::run_self_test(live_tts) {
            Ok(()) => std::process::exit(0),
            Err(err) => {
                eprintln!("SELF-TEST FAILED: {err}");
                std::process::exit(1);
            }
        }
    }

    bookreader_lib::run();
}
