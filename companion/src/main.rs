mod oauth;
mod protocol;
mod stream;

use serde_json::{Value, json};
use std::io;

fn dispatch(request: protocol::Request) -> Value {
    let result = oauth::with_session_lock(|| match request.command.as_str() {
        "status" => oauth::status(),
        "signIn" => oauth::sign_in(),
        "disconnect" => oauth::disconnect(),
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
