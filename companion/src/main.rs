// Browsers start the host with stdio pipes, so it needs no console window either.
#![cfg_attr(windows, windows_subsystem = "windows")]
mod install;
mod oauth;
mod protocol;
mod setup;
mod stream;
mod strings;

use serde_json::{Value, json};
use std::io;

fn dispatch(request: protocol::Request) -> Value {
    let result = oauth::with_session_lock(|| match request.command.as_str() {
        "status" => oauth::status(),
        "signIn" => oauth::sign_in(request.payload),
        "disconnect" => oauth::disconnect(),
        "removeAccount" => oauth::remove_account(request.payload),
        "models" => oauth::models(),
        "check" => oauth::check(request.payload),
        _ => Err("Unknown companion command.".into()),
    });
    match result {
        Ok(result) => json!({"id":request.id,"ok":true,"result":result}),
        Err(error) => json!({"id":request.id,"ok":false,"error":error}),
    }
}

fn main() {
    // Browsers pass the caller's origin or manifest path. Without them, show setup.
    // Older macOS versions add a process serial number when opening an app.
    if std::env::args_os()
        .skip(1)
        .all(|argument| argument.to_string_lossy().starts_with("-psn_"))
    {
        if let Err(error) = setup::run() {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    // Native messaging stdout must contain framed JSON only, including failures.
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    loop {
        match protocol::read_message(&mut input) {
            Ok(Some(request)) => {
                if protocol::write_message(&mut output, &dispatch(request)).is_err() {
                    break;
                }
            }
            Ok(None) => break,
            Err(_) => {
                let _ = protocol::write_message(
                    &mut output,
                    &json!({"id":"","ok":false,"error":"Invalid native message."}),
                );
                break;
            }
        }
    }
}
