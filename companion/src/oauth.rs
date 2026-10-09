use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use directories::ProjectDirs;
use fs2::FileExt;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::JwkSet};
use rand::Rng;
use reqwest::blocking::{Client, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use url::Url;
use uuid::{Uuid, Variant};

const ISSUER: &str = "https://auth.openai.com";
const TOKEN_URL: &str = "https://auth.openai.com/api/accounts/oauth/token";
const RESOURCE: &str = "https://api.openai.com/v1";
const BOOTSTRAP: &str = "dynamic_agent_client";
const SCOPE: &str = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
type Result<T> = std::result::Result<T, String>;

#[derive(Serialize, Deserialize)]
struct Session {
    client_id: String,
    subject: String,
    email: Option<String>,
    access_token: String,
    refresh_token: String,
    id_token: String,
    scopes: Vec<String>,
    expires_at: u64,
}

/// Account registrations survive sign-out; renewable credentials stay in the OS vault.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Registration {
    client_id: String,
    subject_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    email: Option<String>,
}
impl Registration {
    fn from_session(session: &Session) -> Self {
        Self {
            client_id: session.client_id.clone(),
            subject_hash: Some(subject_hash(&session.subject)),
            email: session.email.clone(),
        }
    }
    fn accepts_subject(&self, subject: &str) -> bool {
        self.subject_hash
            .as_ref()
            .is_none_or(|expected| *expected == subject_hash(subject))
    }
}
fn subject_hash(subject: &str) -> String {
    Sha256::digest(subject.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn valid_registration(registration: &Registration) -> bool {
    !registration.client_id.is_empty()
        && registration.client_id != BOOTSTRAP
        && registration.client_id.len() <= 1000
        && !registration.client_id.chars().any(char::is_control)
        && registration
            .subject_hash
            .as_ref()
            .is_none_or(|value| value.len() == 64 && value.chars().all(|ch| ch.is_ascii_hexdigit()))
        && registration
            .email
            .as_ref()
            .is_none_or(|email| email.len() <= 320 && !email.chars().any(char::is_control))
}

#[derive(Default, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Accounts {
    selected: Option<String>,
    registrations: Vec<Registration>,
}
impl Accounts {
    fn valid(&self) -> bool {
        let mut ids = std::collections::HashSet::new();
        self.registrations
            .iter()
            .all(|account| valid_registration(account) && ids.insert(&account.client_id))
            && match &self.selected {
                Some(id) => self
                    .registrations
                    .iter()
                    .any(|account| &account.client_id == id),
                None => self.registrations.is_empty(),
            }
    }
    fn selected(&self, id: Option<&str>) -> Result<Option<Registration>> {
        let selected = id.or(self.selected.as_deref());
        match selected {
            Some(id) => self
                .registrations
                .iter()
                .find(|account| account.client_id == id)
                .cloned()
                .map(Some)
                .ok_or_else(|| "Unknown saved ChatGPT account.".into()),
            None => Ok(None),
        }
    }
    fn remember(&mut self, account: Registration, select: bool) {
        if select || self.selected.is_none() {
            self.selected = Some(account.client_id.clone());
        }
        if let Some(saved) = self
            .registrations
            .iter_mut()
            .find(|saved| saved.client_id == account.client_id)
        {
            *saved = account;
        } else {
            self.registrations.push(account);
        }
    }
    fn remove(&mut self, id: &str) -> Result<()> {
        self.selected(Some(id))?;
        self.registrations.retain(|account| account.client_id != id);
        if self.selected.as_deref() == Some(id) {
            self.selected = self
                .registrations
                .first()
                .map(|account| account.client_id.clone());
        }
        Ok(())
    }
    fn status(&self, session: Option<&Session>) -> Value {
        json!({"connected":session.is_some(),"email":session.and_then(|session| session.email.as_ref()),
            "selectedAccount":self.selected,"savedAccounts":self.registrations.iter().map(|account|
                json!({"id":account.client_id,"email":account.email})).collect::<Vec<_>>()})
    }
}

fn accounts_at(path: &Path, session: Option<&Session>) -> Result<Accounts> {
    let mut stored = match fs::read(path) {
        Ok(bytes) => {
            // The single-registration form exists in released companions.
            #[derive(Deserialize)]
            #[serde(untagged)]
            enum Saved {
                Accounts(Accounts),
                Registration(Registration),
            }
            let value: Saved = serde_json::from_slice(&bytes)
                .map_err(|_| "Saved ChatGPT accounts are unreadable; they were not replaced.")?;
            let accounts = match value {
                Saved::Accounts(accounts) => accounts,
                Saved::Registration(account) => Accounts {
                    selected: Some(account.client_id.clone()),
                    registrations: vec![account],
                },
            };
            if !accounts.valid() {
                return Err("Saved ChatGPT registration is invalid; it was not replaced.".into());
            }
            accounts
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Accounts::default(),
        Err(_) => return Err("Cannot read the saved ChatGPT registration.".into()),
    };
    let Some(session) = session else {
        return Ok(stored);
    };
    let current = Registration::from_session(session);
    let saved = stored
        .registrations
        .iter()
        .find(|saved| saved.client_id == current.client_id);
    if saved.is_some_and(|saved| !saved.accepts_subject(&session.subject))
        || saved.is_none() && !stored.registrations.is_empty()
    {
        return Err("The saved ChatGPT registration does not match this connection.".into());
    }
    if saved != Some(&current) || stored.selected.as_deref() != Some(&current.client_id) {
        stored.remember(current, true);
        save_accounts_at(path, &stored)?;
    }
    Ok(stored)
}
fn save_accounts_at(path: &Path, accounts: &Accounts) -> Result<()> {
    if !accounts.valid() {
        return Err("Cannot save an invalid ChatGPT registration.".into());
    }
    let bytes =
        serde_json::to_vec(accounts).map_err(|_| "Cannot encode the ChatGPT registration.")?;
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let write = || -> std::io::Result<()> {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    };
    write().map_err(|_| {
        let _ = fs::remove_file(&temporary);
        "Cannot save the ChatGPT registration; credentials were not replaced.".to_string()
    })
}

#[derive(Deserialize)]
struct Tokens {
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
    token_type: String,
    expires_in: u64,
    scope: Option<String>,
}

#[derive(Clone, Deserialize)]
struct Claims {
    sub: String,
    email: Option<String>,
    nonce: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CheckPayload {
    model: String,
    text: String,
    #[serde(default)]
    image_data_urls: Vec<String>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn random_value() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn directory() -> Result<PathBuf> {
    let path = ProjectDirs::from("org", "vegsnap", "vegsnap")
        .ok_or("Cannot locate the user configuration directory.")?
        .config_dir()
        .to_path_buf();
    fs::create_dir_all(&path).map_err(|_| "Cannot create the configuration directory.")?;
    Ok(path)
}

pub fn with_session_lock(action: impl FnOnce() -> Result<Value>) -> Result<Value> {
    // Serializes rotating-token refresh and sign-in across Chrome/Firefox processes.
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory()?.join("session.lock"))
        .map_err(|_| "Cannot open the connection lock.")?;
    FileExt::try_lock_exclusive(&lock)
        .map_err(|_| "Another Vegsnap connection request is running. Try again shortly.")?;
    action()
}

fn host_id() -> Result<String> {
    let path = directory()?.join("host-id");
    host_id_at(&path)
}

fn host_id_at(path: &Path) -> Result<String> {
    match fs::read_to_string(path) {
        Ok(id) if valid_host_id(&id) => Ok(id),
        Ok(_) => Err(format!(
            "The saved ChatGPT host identifier is invalid. Remove only {} and connect again; history and credentials are preserved.",
            path.display()
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // SIWC requires a UUIDv4 URN, unlike the fresh opaque state/nonce/PKCE values.
            let id = Uuid::new_v4().urn().to_string();
            fs::write(path, &id).map_err(|_| "Cannot save the host identifier.")?;
            Ok(id)
        }
        Err(_) => Err("Cannot read the host identifier.".into()),
    }
}

fn valid_host_id(id: &str) -> bool {
    id.strip_prefix("urn:uuid:").is_some_and(|value| {
        Uuid::parse_str(value).is_ok_and(|uuid| {
            uuid.get_version_num() == 4
                && uuid.get_variant() == Variant::RFC4122
                && uuid.hyphenated().to_string().eq_ignore_ascii_case(value)
        })
    })
}

fn entry() -> Result<keyring::Entry> {
    keyring::Entry::new("org.vegsnap.companion", "chatgpt").map_err(|_| {
        "The OS credential store is unavailable. Unlock your wallet and try again.".into()
    })
}

fn load() -> Result<Option<Session>> {
    match entry()?.get_password() {
        Ok(value) => serde_json::from_str(&value)
            .map(Some)
            .map_err(|_| "Stored connection is unreadable. Disconnect and sign in again.".into()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => {
            Err("Cannot read the OS credential store. Unlock your wallet and try again.".into())
        }
    }
}

fn save(session: &Session) -> Result<()> {
    let value = serde_json::to_string(session).map_err(|_| "Cannot encode credentials.")?;
    entry()?
        .set_password(&value)
        .map_err(|_| "Cannot save the connection in the OS credential store.".into())
}

fn client() -> Result<Client> {
    Client::builder()
        .timeout(Duration::from_secs(120))
        .connect_timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Vegsnap/0.1.0")
        .build()
        .map_err(|_| "Cannot initialize the connection.".into())
}

fn checked(response: Response) -> Result<Response> {
    if response.status().is_success() {
        Ok(response)
    } else {
        let status = response.status().as_u16();
        let mut bytes = Vec::new();
        let _ = response.take(16_385).read_to_end(&mut bytes);
        let details: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        if let Some(message) = crate::stream::plan_usage_error(&details) {
            return Err(message.into());
        }
        let hints: Vec<&str> = ["code", "param"]
            .iter()
            .filter_map(|key| details["error"][key].as_str())
            .filter(|value| {
                value.len() <= 100
                    && value
                        .chars()
                        .all(|ch| ch.is_ascii_alphanumeric() || "_-.[]".contains(ch))
            })
            .collect();
        let message = details["error"]["message"]
            .as_str()
            .or_else(|| details["detail"].as_str())
            .unwrap_or_default();
        let parameter_error = if message.to_ascii_lowercase().contains("unsupported")
            || message.to_ascii_lowercase().contains("not supported")
            || message.to_ascii_lowercase().contains("required")
        {
            message
                .chars()
                .take(400)
                .filter(|ch| !ch.is_control())
                .collect::<String>()
        } else {
            String::new()
        };
        Err(format!(
            "The provider returned HTTP {status}{}. {parameter_error} Check your connection, selected model and tool support.",
            if hints.is_empty() {
                String::new()
            } else {
                format!(" ({})", hints.join(", "))
            }
        ))
    }
}

fn json_response<T: serde::de::DeserializeOwned>(response: Response) -> Result<T> {
    let response = checked(response)?;
    let mut bytes = Vec::new();
    response
        .take(1_048_577)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read the provider response.")?;
    if bytes.len() > 1_048_576 {
        return Err("The provider response is too large.".into());
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "The provider returned an unexpected response.".into())
}

pub fn status() -> Result<Value> {
    let session = load()?;
    let accounts = accounts_at(
        &directory()?.join("chatgpt-registration.json"),
        session.as_ref(),
    )?;
    Ok(accounts.status(session.as_ref()))
}

pub fn disconnect() -> Result<Value> {
    // Preserve a readable registration before removing its renewable credentials. Corrupt
    // token records can still be cleared; an existing registration remains authoritative.
    let session = load().ok().flatten();
    let accounts = accounts_at(
        &directory()?.join("chatgpt-registration.json"),
        session.as_ref(),
    )?;
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(accounts.status(None)),
        Err(_) => Err("Cannot remove credentials from the OS credential store.".into()),
    }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignInPayload {
    account_id: Option<String>,
    #[serde(default)]
    new_account: bool,
}
impl SignInPayload {
    fn registration(&self, accounts: &Accounts) -> Result<Option<Registration>> {
        if self.new_account && self.account_id.is_some() {
            return Err("Select a saved account or add another account.".into());
        }
        if self.new_account {
            Ok(None)
        } else {
            accounts.selected(self.account_id.as_deref())
        }
    }
}

pub fn remove_account(payload: Value) -> Result<Value> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct RemoveAccountPayload {
        account_id: String,
    }
    let input: RemoveAccountPayload =
        serde_json::from_value(payload).map_err(|_| "Invalid saved account selection.")?;
    let session = load()?;
    let path = directory()?.join("chatgpt-registration.json");
    let mut accounts = accounts_at(&path, session.as_ref())?;
    accounts.remove(&input.account_id)?;
    let active = session
        .as_ref()
        .is_some_and(|session| session.client_id == input.account_id);
    if active {
        match entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(_) => return Err("Cannot remove credentials from the OS credential store.".into()),
        }
    }
    save_accounts_at(&path, &accounts)?;
    Ok(accounts.status(if active { None } else { session.as_ref() }))
}

fn validate_identity(
    client: &Client,
    token: &str,
    client_id: &str,
    nonce: Option<&str>,
) -> Result<Claims> {
    let keys: JwkSet = json_response(
        client
            .get(format!("{ISSUER}/.well-known/jwks.json"))
            .send()
            .map_err(|_| "Cannot retrieve identity verification keys.")?,
    )?;
    validate_identity_with_keys(token, client_id, nonce, &keys)
}

fn validate_identity_with_keys(
    token: &str,
    client_id: &str,
    nonce: Option<&str>,
    keys: &JwkSet,
) -> Result<Claims> {
    let header = decode_header(token).map_err(|_| "Invalid identity token.")?;
    if !matches!(header.alg, Algorithm::RS256 | Algorithm::ES256) {
        return Err("Unsupported identity signature algorithm.".into());
    }
    let key = keys
        .find(
            header
                .kid
                .as_deref()
                .ok_or("Identity key identifier missing.")?,
        )
        .ok_or("Identity verification key not found.")?;
    let mut validation = Validation::new(header.alg);
    validation.set_audience(&[client_id]);
    validation.set_issuer(&[ISSUER]);
    validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
    validation.validate_nbf = true;
    validation.leeway = 30;
    let claims = decode::<Claims>(
        token,
        &DecodingKey::from_jwk(key).map_err(|_| "Invalid verification key.")?,
        &validation,
    )
    .map_err(|_| "Identity signature or claims could not be verified.")?
    .claims;
    if claims.sub.is_empty()
        || nonce.is_some_and(|expected| claims.nonce.as_deref() != Some(expected))
    {
        return Err("Identity does not match this sign-in attempt.".into());
    }
    Ok(claims)
}

fn validate_tokens(tokens: &Tokens, fallback_scopes: Option<&[String]>) -> Result<Vec<String>> {
    if !tokens.token_type.eq_ignore_ascii_case("bearer")
        || tokens.access_token.is_empty()
        || tokens.expires_in == 0
    {
        return Err("The provider did not return usable credentials.".into());
    }
    let scopes = tokens
        .scope
        .as_ref()
        .map(|s| s.split_whitespace().map(str::to_string).collect())
        .or_else(|| fallback_scopes.map(<[String]>::to_vec))
        .unwrap_or_default();
    if !scopes
        .iter()
        .any(|scope| scope == "chatgpt.tokens.use.direct")
    {
        return Err("ChatGPT plan usage was not granted. Enable it during sign-in.".into());
    }
    Ok(scopes)
}

fn authorization_url(
    host: &str,
    client_id: &str,
    redirect: &str,
    state: &str,
    nonce: &str,
    verifier: &str,
) -> Url {
    let mut url = Url::parse("https://auth.openai.com/api/accounts/authorize").expect("fixed URL");
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    url.query_pairs_mut().extend_pairs([
        ("client_id", client_id),
        ("ext_agent_host_id", host),
        ("response_type", "code"),
        ("redirect_uri", redirect),
        ("scope", SCOPE),
        ("resource", RESOURCE),
        ("state", state),
        ("nonce", nonce),
        ("code_challenge_method", "S256"),
        ("code_challenge", &challenge),
    ]);
    if client_id == BOOTSTRAP {
        url.query_pairs_mut()
            .append_pair("agent_name_hint", "Vegsnap");
    }
    url
}

fn callback(target: &str, state: &str, returning_id: Option<&str>) -> Result<(String, String)> {
    if !target.starts_with("/auth/callback?") {
        return Err("Invalid callback path.".into());
    }
    let url = Url::parse(&format!("http://127.0.0.1{target}")).map_err(|_| "Invalid callback.")?;
    let mut params = HashMap::new();
    for (key, value) in url.query_pairs() {
        if params
            .insert(key.into_owned(), value.into_owned())
            .is_some()
        {
            return Err("Repeated callback parameter.".into());
        }
    }
    if params.get("state").map(String::as_str) != Some(state) {
        return Err("Invalid sign-in state.".into());
    }
    if params.contains_key("error") {
        return Err("Sign-in was declined or could not be completed.".into());
    }
    let client_id = match (returning_id, params.get("client_id")) {
        (Some(expected), Some(actual)) if expected != actual => {
            return Err("Registration changed during sign-in.".into());
        }
        (Some(expected), _) => expected.to_string(),
        (None, Some(actual)) if !actual.is_empty() && actual != BOOTSTRAP => actual.clone(),
        _ => return Err("Sign-in did not return an issued client ID.".into()),
    };
    let code = params
        .get("code")
        .filter(|c| !c.is_empty())
        .ok_or("Authorization code missing.")?
        .clone();
    Ok((code, client_id))
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn callback_response(status: &str, title: &str, message: &str) -> String {
    let body = include_str!("../../contracts/auth-completion.html")
        .replace("{{ACTION}}", "")
        .replace("{{SCRIPT}}", "")
        .replace("{{TITLE}}", &escape_html(title))
        .replace("{{MESSAGE}}", &escape_html(message));
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn complete_sign_in<T>(writer: &mut impl Write, finish: impl FnOnce() -> Result<T>) -> Result<T> {
    // The callback only proves authorization reached us. Report success to the
    // browser after token validation and durable credential storage also succeed.
    let result = finish();
    let response = match &result {
        Ok(_) => callback_response(
            "200 OK",
            "Connected to ChatGPT",
            "Return to Vegsnap in Firefox. You can close this tab.",
        ),
        Err(error) => callback_response(
            "502 Bad Gateway",
            "Could not connect to ChatGPT",
            &format!("{error} Return to Vegsnap in Firefox to try again."),
        ),
    };
    // Closing the browser tab must not discard a successfully stored connection.
    let _ = writer.write_all(response.as_bytes());
    result
}

pub fn sign_in(payload: Value) -> Result<Value> {
    let input: SignInPayload = if payload.is_null() {
        SignInPayload::default()
    } else {
        serde_json::from_value(payload).map_err(|_| "Invalid saved account selection.")?
    };
    let previous = load()?;
    let registration_path = directory()?.join("chatgpt-registration.json");
    let mut accounts = accounts_at(&registration_path, previous.as_ref())?;
    let registration = input.registration(&accounts)?;
    let pending_id = registration.as_ref().map(|saved| saved.client_id.as_str());
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|_| "Cannot start the local sign-in callback.")?;
    listener
        .set_nonblocking(true)
        .map_err(|_| "Cannot initialize the callback listener.")?;
    let redirect = format!(
        "http://127.0.0.1:{}/auth/callback",
        listener
            .local_addr()
            .map_err(|_| "Cannot determine callback address.")?
            .port()
    );
    let state = random_value();
    let nonce = random_value();
    let verifier = random_value();
    let mut url = authorization_url(
        &host_id()?,
        pending_id.unwrap_or(BOOTSTRAP),
        &redirect,
        &state,
        &nonce,
        &verifier,
    );
    if let Some(email) = registration
        .as_ref()
        .and_then(|account| account.email.as_deref())
    {
        url.query_pairs_mut().append_pair("login_hint", email);
    }
    webbrowser::open(url.as_str()).map_err(|_| "Cannot open the system browser for sign-in.")?;
    let deadline = Instant::now() + Duration::from_secs(180);
    let (code, client_id, mut callback_socket) = loop {
        if Instant::now() > deadline {
            return Err("Sign-in timed out. Try again when ready.".into());
        }
        let (mut socket, _) = match listener.accept() {
            Ok(connection) => connection,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(_) => return Err("The sign-in listener stopped unexpectedly.".into()),
        };
        let _ = socket.set_read_timeout(Some(Duration::from_secs(2)));
        let _ = socket.set_write_timeout(Some(Duration::from_secs(2)));
        let mut line = String::new();
        let read = BufReader::new((&socket).take(16_385)).read_line(&mut line);
        if read.is_err() || line.len() > 16_384 {
            continue;
        }
        let mut parts = line.split_whitespace();
        let method = parts.next().unwrap_or_default();
        let target = parts.next().unwrap_or_default();
        if method != "GET" {
            continue;
        }
        match callback(target, &state, pending_id) {
            Ok((code, client_id)) => break (code, client_id, socket),
            Err(error) => {
                let response = callback_response(
                    "400 Bad Request",
                    "Could not complete sign-in",
                    &format!("{error} Return to Vegsnap in Firefox to try again."),
                );
                let _ = socket.write_all(response.as_bytes());
                // Ignore unrelated connections; a valid-state refusal ends this attempt.
                if Url::parse(&format!("http://127.0.0.1{target}"))
                    .ok()
                    .is_some_and(|u| u.query_pairs().any(|(k, v)| k == "state" && v == state))
                {
                    return Err(error);
                }
            }
        }
    };
    drop(listener);
    complete_sign_in(&mut callback_socket, || {
        // A state-validated callback issues the registration before token exchange.
        // Retain it even if that one-time code expires or the network fails.
        accounts.remember(
            Registration {
                client_id: client_id.clone(),
                subject_hash: registration
                    .as_ref()
                    .and_then(|saved| saved.subject_hash.clone()),
                email: registration.as_ref().and_then(|saved| saved.email.clone()),
            },
            previous.is_none(),
        );
        save_accounts_at(&registration_path, &accounts)?;
        let client = client()?;
        let tokens: Tokens = json_response(
            client
                .post(TOKEN_URL)
                .form(&[
                    ("grant_type", "authorization_code"),
                    ("client_id", &client_id),
                    ("code", &code),
                    ("code_verifier", &verifier),
                    ("redirect_uri", &redirect),
                    ("resource", RESOURCE),
                ])
                .send()
                .map_err(|_| "Could not exchange the authorization code.")?,
        )?;
        let scopes = validate_tokens(&tokens, None)?;
        let id_token = tokens.id_token.ok_or("Identity token missing.")?;
        let claims = validate_identity(&client, &id_token, &client_id, Some(&nonce))?;
        if registration
            .as_ref()
            .is_some_and(|saved| !saved.accepts_subject(&claims.sub))
        {
            return Err("This sign-in selected a different account. Reconnect the registered ChatGPT account.".into());
        }
        let refresh_token = tokens
            .refresh_token
            .filter(|t| !t.is_empty())
            .ok_or("Refresh permission missing.")?;
        let session = Session {
            client_id,
            subject: claims.sub,
            email: claims.email,
            id_token,
            access_token: tokens.access_token,
            refresh_token,
            scopes,
            expires_at: now().saturating_add(tokens.expires_in),
        };
        accounts.remember(Registration::from_session(&session), true);
        save_accounts_at(&registration_path, &accounts)?;
        save(&session)?;
        Ok(accounts.status(Some(&session)))
    })
}

fn active_session(client: &Client) -> Result<Session> {
    let mut session = load()?.ok_or("Connect ChatGPT first.")?;
    if session.expires_at > now().saturating_add(60) {
        return Ok(session);
    }
    let tokens: Tokens = json_response(
        client
            .post(TOKEN_URL)
            .form(&[
                ("grant_type", "refresh_token"),
                ("client_id", session.client_id.as_str()),
                ("refresh_token", session.refresh_token.as_str()),
                ("resource", RESOURCE),
            ])
            .send()
            .map_err(|_| "Could not refresh the connection. Try signing in again.")?,
    )?;
    let scopes = validate_tokens(&tokens, Some(&session.scopes))?;
    if let Some(id_token) = tokens.id_token {
        let identity = validate_identity(client, &id_token, &session.client_id, None)?;
        if identity.sub != session.subject {
            return Err("Account changed during refresh.".into());
        }
        session.id_token = id_token;
        session.email = identity.email;
    }
    session.access_token = tokens.access_token;
    if let Some(refresh_token) = tokens.refresh_token.filter(|t| !t.is_empty()) {
        session.refresh_token = refresh_token;
    }
    session.scopes = scopes;
    session.expires_at = now().saturating_add(tokens.expires_in);
    save(&session)?;
    Ok(session)
}

fn model_image_support(model: &Value) -> Option<bool> {
    for field in ["supportsImages", "supports_image_input", "supports_vision"] {
        if let Some(value) = model[field].as_bool() {
            return Some(value);
        }
    }
    if let Some(value) = model["capabilities"]["vision"].as_bool() {
        return Some(value);
    }
    let modalities = model
        .get("input_modalities")
        .or_else(|| model.get("architecture")?.get("input_modalities"))?
        .as_array()?;
    if modalities.is_empty() || modalities.iter().any(|value| !value.is_string()) {
        return None;
    }
    Some(modalities.iter().any(|value| {
        value
            .as_str()
            .is_some_and(|text| text.eq_ignore_ascii_case("image"))
    }))
}

fn catalog_model(model: &Value) -> Option<Value> {
    let mut result = json!({"id":model["slug"].as_str()?,"name":model["display_name"].as_str()?});
    if let Some(supported) = model_image_support(model) {
        result["supportsImages"] = json!(supported);
    }
    Some(result)
}

pub fn models() -> Result<Value> {
    let client = client()?;
    let session = active_session(&client)?;
    let response: Value = json_response(
        client
            .get(format!("{RESOURCE}/models"))
            .bearer_auth(&session.access_token)
            .send()
            .map_err(|_| "Cannot retrieve models.")?,
    )?;
    let models: Vec<Value> = response["models"]
        .as_array()
        .ok_or("Unexpected model catalog.")?
        .iter()
        .filter(|m| m["visibility"] == "list")
        .filter_map(catalog_model)
        .collect();
    Ok(json!({"models":models}))
}

fn check_content(payload: CheckPayload) -> Result<(String, Vec<Value>)> {
    if payload.model.trim().is_empty()
        || payload.model.len() > 200
        || payload.text.len() > 32_000
        || payload.image_data_urls.len() > 3
    {
        return Err("Invalid model or product text length.".into());
    }
    let mut content = vec![json!({"type":"input_text","text":payload.text})];
    for image in payload.image_data_urls {
        let encoded = [
            "data:image/jpeg;base64,",
            "data:image/png;base64,",
            "data:image/webp;base64,",
        ]
        .iter()
        .find_map(|prefix| image.strip_prefix(prefix));
        if image.len() > 4_000_000
            || encoded.is_none_or(|data| {
                data.is_empty()
                    || base64::engine::general_purpose::STANDARD
                        .decode(data)
                        .is_err()
            })
        {
            return Err("Only a resized product image is accepted.".into());
        }
        content.push(json!({"type":"input_image","image_url":image}));
    }
    Ok((payload.model, content))
}

fn extraction_json(text: &str) -> Option<Value> {
    if text.len() > 100_000 {
        return None;
    }
    let text = text.trim();
    let text = text
        .strip_prefix("```json")
        .or_else(|| text.strip_prefix("```"))
        .unwrap_or(text);
    serde_json::from_str(text.strip_suffix("```").unwrap_or(text).trim()).ok()
}

fn same_product(first: &Value, next: &Value, name_field: &str) -> bool {
    [("name", name_field), ("brand", "brand")]
        .iter()
        .all(|(left, right)| {
            first[*left].as_str().map(|text| text.trim().to_lowercase())
                == next[*right].as_str().map(|text| text.trim().to_lowercase())
        })
}

// Only already-consulted, matching public composition may supply follow-up terms.
// Supplied text, photos and their private annotations never enter this payload.
fn unresolved_public_ingredients(extracted: &Value, research: &Value) -> Vec<String> {
    let sources = research["sources"].as_array().cloned().unwrap_or_default();
    let compositions: Vec<&str> = extracted["webCompositions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| {
            same_product(extracted, item, "productName")
                && matches!(
                    item["sourceType"].as_str(),
                    Some("manufacturer" | "retailer")
                )
                && item["url"].is_string()
                && sources.iter().any(|source| source["url"] == item["url"])
        })
        .filter_map(|item| item["text"].as_str())
        .collect();
    let mut unresolved = Vec::new();
    for item in extracted["ingredientAssessments"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let Some(term) = item["term"]
            .as_str()
            .filter(|term| !term.trim().is_empty() && term.encode_utf16().count() <= 300)
        else {
            continue;
        };
        if matches!(item["status"].as_str(), Some("unknown" | "ambiguous"))
            && compositions
                .iter()
                .any(|text| text.to_lowercase().contains(&term.to_lowercase()))
            && !unresolved
                .iter()
                .any(|existing: &String| existing.eq_ignore_ascii_case(term))
        {
            unresolved.push(term.to_string());
            if unresolved.len() == 20 {
                break;
            }
        }
    }
    unresolved
}

fn research_content(
    analysis: &crate::stream::AnalysisResponse,
    content: &[Value],
) -> Option<Vec<Value>> {
    let extracted = extraction_json(&analysis.text)?;
    let name = extracted["name"]
        .as_str()
        .filter(|value| !value.trim().is_empty() && value.len() <= 1200)?;
    let brand = extracted["brand"]
        .as_str()
        .filter(|value| !value.trim().is_empty() && value.len() <= 1200)?;
    let searched = analysis.research["searched"] == true;
    let unresolved = unresolved_public_ingredients(&extracted, &analysis.research);
    if if searched {
        unresolved.is_empty()
    } else {
        extracted["complete"] != false
    } {
        return None;
    }
    let visible_label = content.iter().any(|part| part["type"] == "input_image")
        && extracted["labelObservations"]
            .as_array()
            .is_some_and(|labels| {
                labels.iter().any(|label| {
                    let text = label["text"].as_str().unwrap_or_default().to_lowercase();
                    text.split_whitespace().any(|word| word == "vegan")
                        && ![
                            "not vegan",
                            "non-vegan",
                            "nicht vegan",
                            "kein vegan",
                            "keine vegan",
                            "inte vegan",
                            "ej vegan",
                            "vegetarian",
                            "vegetarisch",
                            "vegetarisk",
                        ]
                        .iter()
                        .any(|term| text.contains(term))
                })
            });
    let visible_animal = extracted["text"]
        .as_str()
        .is_some_and(|text| !text.trim().is_empty())
        && extracted["ingredientAssessments"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item["status"] == "animal"));
    if visible_label || visible_animal {
        return None;
    }
    let original: Value = content
        .first()
        .and_then(|part| part["text"].as_str())
        .and_then(|text| serde_json::from_str(text).ok())
        .unwrap_or(Value::Null);
    let mut identity = json!({
        "name":name,"brand":brand,"category":extracted["category"],
        "market":original["market"].as_str().unwrap_or("DE"),
        "locale":original["locale"].as_str().unwrap_or("en")
    });
    if !unresolved.is_empty() {
        identity["unresolvedIngredients"] = json!(unresolved);
    }
    Some(vec![
        json!({"type":"input_text", "text":identity.to_string()}),
    ])
}

// These are the only model fields copied from a follow-up into a completed first result.
// Validate them before merging so the extension's strict schema cannot discard that first result.
fn valid_research_additions(value: &Value) -> bool {
    let text = |item: &Value, field: &str, limit: usize| {
        item[field].as_str().is_some_and(|text| {
            !text
                .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
                .is_empty()
                && text.encode_utf16().count() <= limit
        })
    };
    let url = |item: &Value| {
        text(item, "url", 2000)
            && item["url"]
                .as_str()
                .and_then(|value| Url::parse(value).ok())
                .is_some_and(|url| {
                    matches!(url.scheme(), "https" | "http")
                        && url.username().is_empty()
                        && url.password().is_none()
                })
    };
    for (field, maximum, fields) in [
        (
            "ingredientAssessments",
            100,
            &["term", "translatedTerm", "status", "explanation"][..],
        ),
        (
            "webClaims",
            5,
            &[
                "url",
                "quote",
                "claim",
                "sourceType",
                "productName",
                "brand",
            ][..],
        ),
        (
            "webCompositions",
            3,
            &[
                "url",
                "text",
                "complete",
                "sourceType",
                "productName",
                "brand",
            ][..],
        ),
    ] {
        let Some(items) = value.get(field) else {
            continue;
        };
        let Some(items) = items.as_array() else {
            return false;
        };
        if items.len() > maximum {
            return false;
        }
        for item in items {
            let Some(object) = item.as_object() else {
                return false;
            };
            if object.keys().any(|key| !fields.contains(&key.as_str())) {
                return false;
            }
            let valid = if field == "ingredientAssessments" {
                text(item, "term", 300)
                    && (item.get("translatedTerm").is_none() || text(item, "translatedTerm", 300))
                    && text(item, "explanation", 1000)
                    && matches!(
                        item["status"].as_str(),
                        Some("plant" | "animal" | "ambiguous" | "unknown")
                    )
            } else {
                url(item)
                    && text(item, "productName", 300)
                    && text(item, "brand", 300)
                    && if field == "webClaims" {
                        text(item, "quote", 1000)
                            && matches!(item["claim"].as_str(), Some("vegan" | "not_vegan"))
                            && matches!(
                                item["sourceType"].as_str(),
                                Some("manufacturer" | "certification")
                            )
                    } else {
                        text(item, "text", 20_000)
                            && item["complete"].is_boolean()
                            && matches!(
                                item["sourceType"].as_str(),
                                Some("manufacturer" | "retailer")
                            )
                    }
            };
            if !valid {
                return false;
            }
        }
    }
    true
}

fn research_if_needed(
    first: crate::stream::AnalysisResponse,
    content: &[Value],
    follow_up: impl FnOnce(Vec<Value>) -> Result<crate::stream::AnalysisResponse>,
) -> crate::stream::AnalysisResponse {
    let Some(research_input) = research_content(&first, content) else {
        return first;
    };
    let Ok(researched) = follow_up(research_input) else {
        return first;
    };
    if researched.research["searched"] != true {
        return first;
    }
    let (Some(mut original), Some(next)) = (
        extraction_json(&first.text),
        extraction_json(&researched.text),
    ) else {
        return first;
    };
    if !valid_research_additions(&next) {
        return first;
    }
    if !same_product(&original, &next, "name") {
        return first;
    }
    // Keep both sides of conflicts. Refuse an oversized merge instead of truncating evidence.
    for (field, limit) in [
        ("ingredientAssessments", 100),
        ("webClaims", 5),
        ("webCompositions", 3),
    ] {
        let mut merged = original[field].as_array().cloned().unwrap_or_default();
        for value in next[field].as_array().into_iter().flatten() {
            if !merged.contains(value) {
                merged.push(value.clone());
            }
        }
        if merged.len() > limit {
            return first;
        }
        if !merged.is_empty() {
            original[field] = json!(merged);
        }
    }
    let mut sources = first.research["sources"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for source in researched.research["sources"]
        .as_array()
        .into_iter()
        .flatten()
    {
        if !sources
            .iter()
            .any(|existing| existing["url"] == source["url"])
        {
            sources.push(source.clone());
        }
    }
    if sources.len() > 50 {
        return first;
    }
    // Clients validate these optional assessments against the merged tool sources
    // and product identity. Malformed optional fields must not discard evidence.
    if let Some(contact) = next.get("contact").filter(|value| value.is_object()) {
        original["contact"] = contact.clone();
    }
    if let Some(assessment) = next
        .get("companyAssessment")
        .filter(|value| value.is_object())
    {
        let normalize = |value: &Value| {
            value.as_str().map(|text| {
                text.split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .to_lowercase()
            })
        };
        let cited = |url: &Value| {
            url.as_str()
                .is_some_and(|url| sources.iter().any(|source| source["url"] == url))
        };
        let matched = normalize(&assessment["brand"])
            .is_some_and(|brand| !brand.is_empty() && Some(brand) == normalize(&original["brand"]));
        let sourced = assessment["sources"].as_array().is_some_and(|items| {
            !items.is_empty() && items.len() <= 5 && items.iter().all(|item| cited(&item["url"]))
        });
        let ownership = match assessment.get("ownershipSourceUrl") {
            Some(url) => cited(url),
            None => assessment["scope"] != "parent",
        };
        if matched && sourced && ownership {
            original["companyAssessment"] = assessment.clone();
        }
    }
    crate::stream::AnalysisResponse {
        text: original.to_string(),
        research: json!({"searched":true,"sources":sources}),
    }
}

pub fn check(payload: Value) -> Result<Value> {
    let payload: CheckPayload =
        serde_json::from_value(payload).map_err(|_| "Invalid product check request.")?;
    let (model, content) = check_content(payload)?;
    let prompt: Value =
        serde_json::from_str(include_str!("../../contracts/ai-extraction-prompt.json"))
            .map_err(|_| "Extraction instructions are unavailable.")?;
    let instructions = prompt["prompt"]
        .as_str()
        .ok_or("Extraction instructions missing.")?;
    let research_prompt = prompt["researchPrompt"]
        .as_str()
        .ok_or("Research instructions missing.")?;
    let client = client()?;
    let session = active_session(&client)?;
    let deadline = Instant::now() + Duration::from_secs(130);
    let request = |content: Vec<Value>,
                   required: bool|
     -> Result<crate::stream::AnalysisResponse> {
        let timeout = deadline
            .saturating_duration_since(Instant::now())
            .min(Duration::from_secs(120));
        if timeout.is_zero() {
            return Err("Product research timed out.".into());
        }
        let mut body = json!({"model":model,"store":false,"stream":true,
            "instructions":if required { format!("{instructions}\n{research_prompt}") } else { instructions.to_string() },
            "tools":[{"type":"web_search"}], "include":["web_search_call.action.sources"],
            "input":[{"role":"user","content":content}]});
        if required {
            body["tool_choice"] = json!("required");
        }
        let response = checked(
            client
                .post(format!("{RESOURCE}/responses"))
                .bearer_auth(&session.access_token)
                .timeout(timeout)
                .json(&body)
                .send()
                .map_err(|_| "The product check could not reach the provider.")?,
        )?;
        crate::stream::read_response(BufReader::new(response))
    };
    let first = request(content.clone(), false)?;
    let analysis = research_if_needed(first, &content, |identity| request(identity, true));
    Ok(json!({"text":analysis.text,"research":analysis.research}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{EncodingKey, Header, encode};

    #[test]
    fn http_plan_errors_share_safe_stream_recovery_messages() {
        for (status, code) in [
            (429, "subscription_sharing_usage_limit_exceeded"),
            (503, "subscription_sharing_usage_unavailable"),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let details = json!({"error":{"code":code,"message":"private provider detail"}});
            let expected = crate::stream::plan_usage_error(&details)
                .unwrap()
                .to_string();
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(socket.try_clone().unwrap());
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                        break;
                    }
                }
                let body = details.to_string();
                write!(socket, "HTTP/1.1 {status} Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            });
            let response = Client::new()
                .get(format!("http://{address}/responses"))
                .send()
                .unwrap();
            assert_eq!(checked(response).unwrap_err(), expected);
            server.join().unwrap();
        }
    }

    #[test]
    fn catalog_preserves_only_explicit_image_capabilities_and_public_labels() {
        let model = json!({"slug":"example","display_name":"Example","input_modalities":["text","image"],"private":"do not forward"});
        assert_eq!(
            catalog_model(&model).unwrap(),
            json!({"id":"example","name":"Example","supportsImages":true})
        );
        assert_eq!(
            model_image_support(&json!({"input_modalities":["text"]})),
            Some(false)
        );
        assert_eq!(
            model_image_support(
                &json!({"supports_image_input":false,"input_modalities":["image"]})
            ),
            Some(false)
        );
        assert_eq!(
            model_image_support(&json!({"architecture":{"input_modalities":["text","image"]}})),
            Some(true)
        );
        assert_eq!(
            model_image_support(&json!({"capabilities":{"vision":true}})),
            Some(true)
        );
        for metadata in [
            json!({}),
            json!({"input_modalities":[]}),
            json!({"supports_image_input":"false"}),
            json!({"output_modalities":["text"]}),
        ] {
            assert_eq!(model_image_support(&metadata), None);
        }
        assert!(
            catalog_model(&json!({"slug":"custom","display_name":"Custom"}))
                .unwrap()
                .get("supportsImages")
                .is_none()
        );
    }

    fn research_fixture(searched: bool) -> crate::stream::AnalysisResponse {
        crate::stream::AnalysisResponse {
            text: json!({"text":"","complete":false,"category":"food","name":"Granola Kakao & Hallon","brand":"Paulúns"}).to_string(),
            research: json!({"searched":searched,"sources":[]}),
        }
    }

    #[test]
    fn research_followup_preserves_contact_with_actual_source_provenance() {
        let contact = json!({"email":"care@maker.example","sourceUrl":"https://maker.example/contact","productName":"Granola Kakao & Hallon","brand":"Paulúns"});
        for searched in [false, true] {
            let result = research_if_needed(research_fixture(false), &[], |_| {
                let mut next = research_fixture(searched);
                let mut extracted = extraction_json(&next.text).unwrap();
                extracted["contact"] = contact.clone();
                next.text = extracted.to_string();
                next.research["sources"] =
                    json!([{"url":"https://maker.example/contact","title":"Customer service"}]);
                Ok(next)
            });
            let extracted = extraction_json(&result.text).unwrap();
            if searched {
                assert_eq!(extracted["contact"], contact);
                assert_eq!(result.research["sources"][0]["url"], contact["sourceUrl"]);
            } else {
                assert!(extracted.get("contact").is_none());
            }
        }
    }

    #[test]
    fn research_followup_preserves_company_assessment_with_tool_sources() {
        let assessment = json!({"brand":"Paulúns","company":"Example maker","scope":"direct","verdict":"inconclusive","summary":"The consulted policy does not resolve animal-testing practices.","categories":[],"sources":[{"url":"https://maker.example/policy","title":"Company policy","quote":"Our policy"}]});
        for searched in [false, true] {
            let result = research_if_needed(research_fixture(false), &[], |_| {
                let mut next = research_fixture(searched);
                let mut extracted = extraction_json(&next.text).unwrap();
                extracted["companyAssessment"] = assessment.clone();
                next.text = extracted.to_string();
                next.research["sources"] =
                    json!([{"url":"https://maker.example/policy","title":"Company policy"}]);
                Ok(next)
            });
            let extracted = extraction_json(&result.text).unwrap();
            if searched {
                assert_eq!(extracted["companyAssessment"], assessment);
                assert_eq!(
                    result.research["sources"][0]["url"],
                    assessment["sources"][0]["url"]
                );
            } else {
                assert!(extracted.get("companyAssessment").is_none());
            }
        }
    }

    #[test]
    fn unsourced_company_followup_keeps_the_initial_assessment() {
        let mut first = research_fixture(false);
        let mut extracted = extraction_json(&first.text).unwrap();
        let assessment = json!({"brand":"Paulúns","company":"Example maker","scope":"direct","verdict":"inconclusive","summary":"The policy is unclear.","categories":[],"sources":[{"url":"https://maker.example/policy","title":"Policy","quote":"Policy text"}]});
        extracted["companyAssessment"] = assessment.clone();
        first.text = extracted.to_string();
        first.research["sources"] =
            json!([{"url":"https://maker.example/policy","title":"Policy"}]);
        let result = research_if_needed(first, &[], |_| {
            let mut next = research_fixture(true);
            let mut extracted = extraction_json(&next.text).unwrap();
            let mut unsupported = assessment.clone();
            unsupported["sources"][0]["url"] = json!("https://unconsulted.example/policy");
            extracted["companyAssessment"] = unsupported;
            next.text = extracted.to_string();
            Ok(next)
        });
        assert_eq!(
            extraction_json(&result.text).unwrap()["companyAssessment"],
            assessment
        );
    }

    #[test]
    fn malformed_optional_contact_does_not_discard_other_research() {
        let result = research_if_needed(research_fixture(false), &[], |_| {
            let mut next = research_fixture(true);
            let mut extracted = extraction_json(&next.text).unwrap();
            extracted["contact"] = json!("malformed");
            extracted["companyAssessment"] = json!("malformed");
            extracted["webCompositions"] = json!([{"url":"https://maker.example/granola","text":"oats","complete":true,"sourceType":"manufacturer","productName":"Granola Kakao & Hallon","brand":"Paulúns"}]);
            next.text = extracted.to_string();
            Ok(next)
        });
        let extracted = extraction_json(&result.text).unwrap();
        assert!(extracted.get("contact").is_none());
        assert!(extracted.get("companyAssessment").is_none());
        assert_eq!(extracted["webCompositions"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn research_followup_sends_only_identity_and_preserves_visible_fields() {
        let content = vec![
            json!({"type":"input_text","text":json!({"text":"private supplied text", "market":"SE","locale":"en"}).to_string()}),
            json!({"type":"input_image","image_url":"data:image/jpeg;base64,YQ=="}),
        ];
        let result = research_if_needed(research_fixture(false), &content, |followup| {
            assert_eq!(followup.len(), 1);
            let serialized = serde_json::to_string(&followup).unwrap();
            assert!(!serialized.contains("private supplied text"));
            assert!(!serialized.contains("data:image"));
            let identity: Value =
                serde_json::from_str(followup[0]["text"].as_str().unwrap()).unwrap();
            assert_eq!(identity["name"], "Granola Kakao & Hallon");
            assert_eq!(identity["market"], "SE");
            let mut next = research_fixture(true);
            let mut extracted = extraction_json(&next.text).unwrap();
            extracted["text"] = json!("must not replace observed text");
            extracted["barcode"] = json!("must not replace observed barcode");
            extracted["webCompositions"] = json!([{"url":"https://maker.example/granola","text":"oats, cocoa","complete":true,"sourceType":"manufacturer","productName":"Granola Kakao & Hallon","brand":"Paulúns"}]);
            next.text = extracted.to_string();
            Ok(next)
        });
        let extracted = extraction_json(&result.text).unwrap();
        assert_eq!(extracted["text"], "");
        assert_eq!(extracted["complete"], false);
        assert!(extracted.get("barcode").is_none());
        assert_eq!(extracted["webCompositions"].as_array().unwrap().len(), 1);
        assert_eq!(result.research["searched"], true);
    }

    #[test]
    fn unresolved_researched_composition_gets_one_private_safe_followup() {
        let mut first = research_fixture(true);
        let mut value = extraction_json(&first.text).unwrap();
        value["webCompositions"] = json!([{"url":"https://retailer.example/granola","text":"oats, vitamin D","complete":true,"sourceType":"retailer","productName":"Granola Kakao & Hallon","brand":"Paulúns"}]);
        value["ingredientAssessments"] =
            json!([{"term":"vitamin D","status":"ambiguous","explanation":"Origin unspecified"}]);
        first.text = value.to_string();
        first.research = json!({"searched":true,"sources":[{"url":"https://retailer.example/granola","title":"Ingredients"}]});
        let content = vec![
            json!({"type":"input_text","text":json!({"text":"private note", "market":"SE"}).to_string()}),
            json!({"type":"input_image","image_url":"data:image/jpeg;base64,YQ=="}),
        ];
        let mut calls = 0;
        let result = research_if_needed(first, &content, |input| {
            calls += 1;
            let public_input = input[0]["text"].as_str().unwrap();
            assert!(!public_input.contains("private note"));
            assert!(!public_input.contains("data:image"));
            let mut next = research_fixture(true);
            let mut value = extraction_json(&next.text).unwrap();
            value["webClaims"] = json!([{"url":"https://maker.example/granola","quote":"This product is vegan","claim":"vegan","sourceType":"manufacturer","productName":"Granola Kakao & Hallon","brand":"Paulúns"}]);
            next.text = value.to_string();
            next.research = json!({"searched":true,"sources":[{"url":"https://maker.example/granola","title":"Manufacturer"}]});
            Ok(next)
        });
        assert_eq!(
            calls, 1,
            "An unresolved origin needs targeted research even after an initial search"
        );
        let merged = extraction_json(&result.text).unwrap();
        assert_eq!(
            merged["webCompositions"][0]["url"],
            "https://retailer.example/granola"
        );
        assert_eq!(merged["webClaims"][0]["claim"], "vegan");
        assert_eq!(result.research["sources"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn researched_followup_terms_must_come_from_consulted_matching_public_composition() {
        let mut first = research_fixture(true);
        let mut value = extraction_json(&first.text).unwrap();
        value["text"] = json!("private ingredient");
        value["webCompositions"] = json!([{"url":"https://maker.example/granola","text":"vitamin D","complete":true,"sourceType":"manufacturer","productName":"Granola Kakao & Hallon","brand":"Paulúns"}]);
        value["ingredientAssessments"] = json!([
            {"term":"vitamin D","status":"ambiguous","explanation":"Unspecified origin"},
            {"term":"private ingredient","status":"unknown","explanation":"Private source"}
        ]);
        let metadata = json!({"searched":true,"sources":[{"url":"https://maker.example/granola","title":"Product"}]});
        first.text = value.to_string();
        first.research = metadata.clone();
        let input = research_content(&first, &[]).unwrap();
        let identity: Value = serde_json::from_str(input[0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(identity["unresolvedIngredients"], json!(["vitamin D"]));
        for mode in ["not_consulted", "wrong_variant", "private_only", "resolved"] {
            let mut data = value.clone();
            first.research = metadata.clone();
            match mode {
                "not_consulted" => first.research["sources"] = json!([]),
                "wrong_variant" => {
                    data["webCompositions"][0]["productName"] = json!("Other flavor")
                }
                "private_only" => {
                    data["ingredientAssessments"][0]["term"] = json!("private ingredient")
                }
                "resolved" => data["ingredientAssessments"][0]["status"] = json!("plant"),
                _ => unreachable!(),
            }
            first.text = data.to_string();
            assert!(research_content(&first, &[]).is_none(), "{mode}");
        }
    }

    #[test]
    fn followup_retains_conflicting_public_evidence_and_refuses_overflow() {
        for (field, limit) in [("webClaims", 5), ("webCompositions", 3), ("sources", 50)] {
            for count in [1, limit] {
                let mut first = research_fixture(false);
                let mut original = extraction_json(&first.text).unwrap();
                let public_entry = |index| match field {
                    "webClaims" => {
                        json!({"url":format!("https://maker.example/{index}"),"quote":"Not vegan","claim":"not_vegan","sourceType":"manufacturer","productName":"Granola Kakao & Hallon","brand":"Paulúns"})
                    }
                    "webCompositions" => {
                        json!({"url":format!("https://maker.example/{index}"),"text":"milk","complete":true,"sourceType":"manufacturer","productName":"Granola Kakao & Hallon","brand":"Paulúns"})
                    }
                    _ => json!({"url":format!("https://maker.example/{index}"),"title":"Product"}),
                };
                let entries: Vec<Value> = (0..count).map(public_entry).collect();
                if field == "sources" {
                    first.research[field] = json!(entries);
                } else {
                    original[field] = json!(entries);
                }
                first.text = original.to_string();
                let saved_text = first.text.clone();
                let saved_research = first.research.clone();
                let result = research_if_needed(first, &[], |_| {
                    let mut next = research_fixture(true);
                    let mut value = extraction_json(&next.text).unwrap();
                    let addition = public_entry(limit);
                    if field == "sources" {
                        next.research[field] = json!([addition]);
                    } else {
                        value[field] = json!([addition]);
                    }
                    next.text = value.to_string();
                    Ok(next)
                });
                if count == limit {
                    assert_eq!(result.text, saved_text, "{field}");
                    assert_eq!(result.research, saved_research, "{field}");
                } else {
                    let merged = extraction_json(&result.text).unwrap();
                    let entries = if field == "sources" {
                        &result.research[field]
                    } else {
                        &merged[field]
                    };
                    assert_eq!(entries.as_array().unwrap().len(), 2, "{field}");
                    assert_eq!(entries[0], public_entry(0));
                }
            }
        }
    }

    #[test]
    fn valid_research_display_translation_preserves_source_term() {
        let result = research_if_needed(research_fixture(false), &[], |_| {
            let mut next = research_fixture(true);
            let mut value = extraction_json(&next.text).unwrap();
            value["ingredientAssessments"] = json!([{"term":"naturlig arom","translatedTerm":"natural flavouring","status":"ambiguous","explanation":"Origin depends on the product."}]);
            next.text = value.to_string();
            Ok(next)
        });
        let assessment = &extraction_json(&result.text).unwrap()["ingredientAssessments"][0];
        assert_eq!(assessment["term"], "naturlig arom");
        assert_eq!(assessment["translatedTerm"], "natural flavouring");
        assert_eq!(assessment["status"], "ambiguous");
    }

    #[test]
    fn malformed_optional_research_keeps_completed_photo_extraction() {
        let composition = json!({"url":"https://maker.example/granola","text":"oats, cocoa","complete":true,"sourceType":"manufacturer","productName":"Granola Kakao & Hallon","brand":"Paulúns"});
        let claim = json!({"url":"https://maker.example/granola","quote":"This product is vegan","claim":"vegan","sourceType":"manufacturer","productName":"Granola Kakao & Hallon","brand":"Paulúns"});
        let assessment = json!({"term":"oats","status":"plant","explanation":"Plant ingredient"});
        let mut cases = vec![
            ("webCompositions", json!({})),
            ("webCompositions", json!([null])),
            ("webCompositions", json!(vec![composition.clone(); 4])),
            ("webClaims", json!("invalid")),
            ("webClaims", json!(vec![claim.clone(); 6])),
            ("ingredientAssessments", json!(true)),
            (
                "ingredientAssessments",
                json!(vec![assessment.clone(); 101]),
            ),
        ];
        for (field, changes) in [
            ("complete", json!("yes")),
            ("text", json!(" ")),
            ("text", json!("x".repeat(20_001))),
            ("sourceType", json!("blog")),
            ("url", json!("javascript:void(0)")),
            ("url", json!("https://user:secret@maker.example/product")),
            ("productName", json!(" ")),
            ("brand", json!("x".repeat(301))),
            ("extra", json!(true)),
        ] {
            let mut item = composition.clone();
            item[field] = changes;
            cases.push(("webCompositions", json!([item])));
        }
        for (field, changes) in [
            ("claim", json!("probably")),
            ("sourceType", json!("retailer")),
            ("quote", json!("x".repeat(1001))),
            ("extra", json!(true)),
        ] {
            let mut item = claim.clone();
            item[field] = changes;
            cases.push(("webClaims", json!([item])));
        }
        for (field, changes) in [
            ("term", json!(" ")),
            ("translatedTerm", json!(7)),
            ("translatedTerm", json!(" ")),
            ("translatedTerm", json!("x".repeat(301))),
            ("status", json!("vegan")),
            ("explanation", json!("x".repeat(1001))),
            ("extra", json!(true)),
        ] {
            let mut item = assessment.clone();
            item[field] = changes;
            cases.push(("ingredientAssessments", json!([item])));
        }
        for (field, invalid) in cases {
            let original = research_fixture(false);
            let result = research_if_needed(research_fixture(false), &[], |_| {
                let mut next = research_fixture(true);
                let mut value = extraction_json(&next.text).unwrap();
                value[field] = invalid.clone();
                next.text = value.to_string();
                Ok(next)
            });
            assert_eq!(result.text, original.text, "Malformed {field}: {invalid}");
            assert_eq!(result.research, original.research);
        }
    }

    #[test]
    fn valid_followup_retains_conflicting_assessments_and_actual_tool_metadata() {
        let mut first = research_fixture(false);
        let mut original = extraction_json(&first.text).unwrap();
        original["ingredientAssessments"] = json!([{"term":"mystery ingredient","status":"plant","explanation":"Initial assessment"}]);
        first.text = original.to_string();
        let actual_research = json!({"searched":true,"sources":[{"url":"https://maker.example/granola","title":"Product"}]});
        let result = research_if_needed(first, &[], |_| {
            let mut next = research_fixture(true);
            let mut value = extraction_json(&next.text).unwrap();
            value["ingredientAssessments"] = json!([{"term":"mystery ingredient","status":"animal","explanation":"Conflicting assessment"}]);
            value["webClaims"] = json!([{"url":"https://maker.example/granola","quote":"Not vegan","claim":"not_vegan","sourceType":"manufacturer","productName":"Granola Kakao & Hallon","brand":"Paulúns"}]);
            value["research"] =
                json!({"searched":true,"sources":[{"url":"https://invented.example"}]});
            next.text = value.to_string();
            next.research = actual_research.clone();
            Ok(next)
        });
        let merged = extraction_json(&result.text).unwrap();
        assert_eq!(merged["ingredientAssessments"].as_array().unwrap().len(), 2);
        assert_eq!(merged["ingredientAssessments"][0]["status"], "plant");
        assert_eq!(merged["ingredientAssessments"][1]["status"], "animal");
        assert_eq!(merged["webClaims"][0]["claim"], "not_vegan");
        assert!(merged.get("research").is_none());
        assert_eq!(result.research, actual_research);
    }

    #[test]
    fn assessment_limit_preserves_first_instead_of_dropping_a_contradiction() {
        for original_count in [99, 100] {
            let mut first = research_fixture(false);
            let mut value = extraction_json(&first.text).unwrap();
            value["ingredientAssessments"] = json!((0..original_count).map(|index|
                json!({"term":format!("unfamiliar ingredient {index}"),"status":"plant","explanation":"First assessment"})
            ).collect::<Vec<_>>());
            first.text = value.to_string();
            let original_text = first.text.clone();
            let original_research = first.research.clone();
            let result = research_if_needed(first, &[], |_| {
                let mut next = research_fixture(true);
                let mut value = extraction_json(&next.text).unwrap();
                value["ingredientAssessments"] = json!([{"term":"unfamiliar ingredient","status":"animal","explanation":"Conflicting origin"}]);
                value["webCompositions"] = json!([{"url":"https://maker.example/granola","text":"unfamiliar ingredient","complete":true,"sourceType":"manufacturer","productName":"Granola Kakao & Hallon","brand":"Paulúns"}]);
                next.text = value.to_string();
                Ok(next)
            });
            if original_count == 100 {
                assert_eq!(result.text, original_text);
                assert_eq!(result.research, original_research);
            } else {
                let merged = extraction_json(&result.text).unwrap();
                assert_eq!(
                    merged["ingredientAssessments"].as_array().unwrap().len(),
                    100
                );
                assert_eq!(merged["ingredientAssessments"][99]["status"], "animal");
                assert_eq!(merged["webCompositions"].as_array().unwrap().len(), 1);
            }
        }
    }

    #[test]
    fn research_followup_skips_resolved_or_searched_without_unresolved_public_terms() {
        let content = vec![json!({"type":"input_image","image_url":"data:image/jpeg;base64,YQ=="})];
        for changes in [
            json!({"complete":true}),
            json!({"name":""}),
            json!({"brand":""}),
            json!({"labelObservations":[{"kind":"vegan_claim","text":"vegan"}]}),
        ] {
            let mut first = research_fixture(false);
            let mut extracted = extraction_json(&first.text).unwrap();
            for (key, value) in changes.as_object().unwrap() {
                extracted[key] = value.clone();
            }
            first.text = extracted.to_string();
            research_if_needed(first, &content, |_| panic!("No research request expected"));
        }
        research_if_needed(research_fixture(true), &content, |_| {
            panic!("Search was already used")
        });
    }

    #[test]
    fn failed_or_mismatched_research_keeps_completed_photo_extraction() {
        for mode in ["failure", "not_searched", "wrong_variant"] {
            let original = research_fixture(false).text;
            let result = research_if_needed(research_fixture(false), &[], |_| {
                if mode == "failure" {
                    return Err("Search failed".into());
                }
                let mut next = research_fixture(mode != "not_searched");
                if mode == "wrong_variant" {
                    let mut value = extraction_json(&next.text).unwrap();
                    value["name"] = json!("Different variant");
                    next.text = value.to_string();
                }
                Ok(next)
            });
            assert_eq!(result.text, original);
            assert_eq!(result.research["searched"], false);
        }
    }

    #[test]
    fn browser_success_waits_for_credentials_to_be_saved() {
        use std::cell::Cell;

        struct AfterSaveWriter<'a> {
            saved: &'a Cell<bool>,
            bytes: Vec<u8>,
        }
        impl Write for AfterSaveWriter<'_> {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                assert!(
                    self.saved.get(),
                    "browser responded before connection was saved"
                );
                self.bytes.extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let saved = Cell::new(false);
        let mut writer = AfterSaveWriter {
            saved: &saved,
            bytes: Vec::new(),
        };
        let result = complete_sign_in(&mut writer, || {
            saved.set(true);
            Ok("saved connection")
        });
        assert_eq!(result.unwrap(), "saved connection");
        let response = String::from_utf8(writer.bytes).unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(response.contains("Connected to ChatGPT"));
        assert!(!response.contains("finish connecting"));
    }

    #[test]
    fn browser_shows_exchange_or_storage_failure_without_success_or_html_injection() {
        let error = "Credential store refused <example> & \"quoted\" 'text'";
        let mut writer = Vec::new();
        let result: Result<()> = complete_sign_in(&mut writer, || Err(error.into()));
        assert_eq!(result.unwrap_err(), error);
        let response = String::from_utf8(writer).unwrap();
        assert!(response.starts_with("HTTP/1.1 502 Bad Gateway\r\n"));
        assert!(response.contains("Could not connect to ChatGPT"));
        assert!(response.contains("&lt;example&gt; &amp; &quot;quoted&quot; &#39;text&#39;"));
        assert!(!response.contains("Connected to ChatGPT"));
        assert!(!response.contains("<example>"));
    }

    #[test]
    fn callback_page_has_private_self_contained_html_and_exact_length() {
        let response = callback_response(
            "400 Bad Request",
            "Could not complete sign-in",
            "Try again.",
        );
        let (headers, body) = response.split_once("\r\n\r\n").unwrap();
        for header in [
            "Content-Type: text/html; charset=utf-8",
            "Cache-Control: no-store",
            "Referrer-Policy: no-referrer",
            "X-Content-Type-Options: nosniff",
            "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        ] {
            assert!(headers.contains(header));
        }
        assert!(headers.contains(&format!("Content-Length: {}", body.len())));
        assert!(body.contains("Vegsnap"));
        assert!(body.contains("<svg"));
        assert!(!body.contains("{{"));
        assert!(!body.contains("<script"));
        assert!(!body.contains("http-equiv=\"refresh\""));
    }

    #[test]
    fn closing_browser_does_not_discard_saved_connection() {
        struct ClosedBrowser;
        impl Write for ClosedBrowser {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "closed",
                ))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        assert_eq!(
            complete_sign_in(&mut ClosedBrowser, || Ok("saved")).unwrap(),
            "saved"
        );
    }

    fn save_test_registration_at(path: &Path, registration: &Registration) -> Result<()> {
        save_accounts_at(
            path,
            &Accounts {
                selected: Some(registration.client_id.clone()),
                registrations: vec![registration.clone()],
            },
        )
    }

    fn registration_test_session() -> Session {
        Session {
            client_id: "oaiapp_test_registration".into(),
            subject: "private-subject".into(),
            email: Some("fixture@example.invalid".into()),
            access_token: "access-secret".into(),
            refresh_token: "refresh-secret".into(),
            id_token: "id-secret".into(),
            scopes: vec![],
            expires_at: now() + 3600,
        }
    }

    #[test]
    fn legacy_registration_loads_without_losing_the_existing_connection() {
        let directory = std::env::temp_dir().join(format!("vegsnap-accounts-{}", random_value()));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("registration.json");
        let session = registration_test_session();
        fs::write(&path, serde_json::to_vec(&json!({"client_id":session.client_id,"subject_hash":subject_hash(&session.subject)})).unwrap()).unwrap();
        let accounts = accounts_at(&path, Some(&session)).unwrap();
        assert_eq!(
            accounts.selected.as_deref(),
            Some(session.client_id.as_str())
        );
        assert_eq!(accounts.registrations.len(), 1);
        assert_eq!(accounts.registrations[0].email, session.email);
        assert_eq!(accounts.status(Some(&session))["connected"], true);
        let reopened = accounts_at(&path, None).unwrap();
        assert_eq!(reopened.registrations, accounts.registrations);
        let persisted = fs::read_to_string(&path).unwrap();
        assert!(!persisted.contains(&session.access_token));
        assert!(!persisted.contains(&session.refresh_token));
        assert!(!persisted.contains(&session.subject));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn multiple_accounts_persist_switch_and_remove_without_losing_other_registrations() {
        let directory = std::env::temp_dir().join(format!("vegsnap-accounts-{}", random_value()));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("registration.json");
        let first = registration_test_session();
        let mut second = registration_test_session();
        second.client_id = "oaiapp_second".into();
        second.subject = "second-subject".into();
        second.email = Some("second@example.invalid".into());
        let mut accounts = accounts_at(&path, Some(&first)).unwrap();
        accounts.remember(Registration::from_session(&second), true);
        save_accounts_at(&path, &accounts).unwrap();
        let mut reopened = accounts_at(&path, Some(&second)).unwrap();
        assert_eq!(reopened.registrations.len(), 2);
        assert_eq!(
            reopened.status(Some(&second))["selectedAccount"],
            second.client_id
        );
        let chosen = SignInPayload {
            account_id: Some(first.client_id.clone()),
            new_account: false,
        }
        .registration(&reopened)
        .unwrap()
        .unwrap();
        assert!(chosen.accepts_subject(&first.subject));
        assert!(!chosen.accepts_subject(&second.subject));
        // A cancelled/new sign-in remembers its issued registration while the active account stays selected.
        reopened.remember(
            Registration {
                client_id: "oaiapp_pending".into(),
                subject_hash: None,
                email: None,
            },
            false,
        );
        save_accounts_at(&path, &reopened).unwrap();
        reopened = accounts_at(&path, Some(&second)).unwrap();
        assert_eq!(
            reopened.selected.as_deref(),
            Some(second.client_id.as_str())
        );
        assert_eq!(
            reopened
                .selected(Some("oaiapp_pending"))
                .unwrap()
                .unwrap()
                .subject_hash,
            None
        );
        assert!(
            SignInPayload {
                new_account: true,
                account_id: None
            }
            .registration(&reopened)
            .unwrap()
            .is_none()
        );
        assert!(
            SignInPayload {
                new_account: true,
                account_id: Some(first.client_id.clone())
            }
            .registration(&reopened)
            .is_err()
        );
        assert!(
            SignInPayload {
                new_account: false,
                account_id: Some("unknown".into())
            }
            .registration(&reopened)
            .is_err()
        );
        reopened.remove(&first.client_id).unwrap();
        assert_eq!(
            reopened.selected.as_deref(),
            Some(second.client_id.as_str())
        );
        reopened.remove(&second.client_id).unwrap();
        assert_eq!(reopened.selected.as_deref(), Some("oaiapp_pending"));
        reopened.remove("oaiapp_pending").unwrap();
        assert!(reopened.selected.is_none());
        assert!(reopened.valid());
        assert!(reopened.remove("unknown").is_err());
        save_accounts_at(&path, &reopened).unwrap();
        assert!(accounts_at(&path, None).unwrap().registrations.is_empty());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn invalid_account_lists_are_not_replaced() {
        let directory = std::env::temp_dir().join(format!("vegsnap-accounts-{}", random_value()));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("registration.json");
        let registration = Registration::from_session(&registration_test_session());
        for accounts in [
            Accounts {
                selected: Some("unknown".into()),
                registrations: vec![registration.clone()],
            },
            Accounts {
                selected: None,
                registrations: vec![registration.clone()],
            },
            Accounts {
                selected: Some(registration.client_id.clone()),
                registrations: vec![registration.clone(), registration.clone()],
            },
        ] {
            let bytes = serde_json::to_vec(&accounts).unwrap();
            fs::write(&path, &bytes).unwrap();
            assert!(accounts_at(&path, None).is_err());
            assert!(save_accounts_at(&path, &accounts).is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn sign_out_keeps_account_registration_and_label_without_tokens() {
        let directory =
            std::env::temp_dir().join(format!("vegsnap-registration-{}", random_value()));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("registration.json");
        let session = registration_test_session();
        assert!(accounts_at(&path, None).unwrap().registrations.is_empty());
        let original = accounts_at(&path, Some(&session))
            .unwrap()
            .selected(None)
            .unwrap()
            .unwrap();
        // The token vault is empty after disconnect; selection must still reuse this registration.
        let returning = accounts_at(&path, None)
            .unwrap()
            .selected(None)
            .unwrap()
            .unwrap();
        assert_eq!(returning, original);
        assert!(returning.accepts_subject(&session.subject));
        assert!(!returning.accepts_subject("different-account"));
        let parameters: HashMap<_, _> = authorization_url(
            "urn:uuid:8fd8cd3c-55d9-4a22-90aa-c42f0ea92bab",
            &returning.client_id,
            "http://127.0.0.1:3210/auth/callback",
            "state",
            "nonce",
            "verifier",
        )
        .query_pairs()
        .into_owned()
        .collect();
        assert_eq!(parameters["client_id"], session.client_id);
        assert!(!parameters.contains_key("agent_name_hint"));
        let persisted = fs::read_to_string(&path).unwrap();
        for secret in [
            &session.subject,
            &session.access_token,
            &session.refresh_token,
            &session.id_token,
        ] {
            assert!(!persisted.contains(secret));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn interrupted_registration_reuses_issued_id_and_cannot_replace_it_with_another_callback() {
        let directory =
            std::env::temp_dir().join(format!("vegsnap-registration-{}", random_value()));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("registration.json");
        let (_, client_id) = callback(
            "/auth/callback?state=expected&code=expired&client_id=oaiapp_issued",
            "expected",
            None,
        )
        .unwrap();
        save_test_registration_at(
            &path,
            &Registration {
                client_id,
                subject_hash: None,
                email: None,
            },
        )
        .unwrap();
        // Failed exchange leaves no token session; its issued registration is nevertheless retained.
        let pending = accounts_at(&path, None)
            .unwrap()
            .selected(None)
            .unwrap()
            .unwrap();
        assert_eq!(pending.client_id, "oaiapp_issued");
        assert!(pending.subject_hash.is_none());
        assert_eq!(
            callback(
                "/auth/callback?state=next&code=fresh",
                "next",
                Some(&pending.client_id)
            )
            .unwrap()
            .1,
            pending.client_id
        );
        assert!(
            callback(
                "/auth/callback?state=next&code=fresh&client_id=oaiapp_other",
                "next",
                Some(&pending.client_id)
            )
            .is_err()
        );
        let mut session = registration_test_session();
        session.client_id = pending.client_id;
        let verified = accounts_at(&path, Some(&session))
            .unwrap()
            .selected(None)
            .unwrap()
            .unwrap();
        assert!(verified.accepts_subject(&session.subject));
        assert!(!verified.accepts_subject("different-account"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn malformed_or_conflicting_registration_never_falls_back_to_a_new_app() {
        let directory =
            std::env::temp_dir().join(format!("vegsnap-registration-{}", random_value()));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("registration.json");
        fs::write(&path, "corrupt registration").unwrap();
        assert!(accounts_at(&path, None).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "corrupt registration");
        let session = registration_test_session();
        save_test_registration_at(&path, &Registration::from_session(&session)).unwrap();
        let before = fs::read(&path).unwrap();
        let mut changed = registration_test_session();
        changed.subject = "different-account".into();
        assert!(accounts_at(&path, Some(&changed)).is_err());
        changed = registration_test_session();
        changed.client_id = "oaiapp_other".into();
        assert!(accounts_at(&path, Some(&changed)).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        assert!(
            save_test_registration_at(
                &path,
                &Registration {
                    client_id: BOOTSTRAP.into(),
                    subject_hash: None,
                    email: None
                }
            )
            .is_err()
        );
        assert_eq!(fs::read(&path).unwrap(), before);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn persisted_host_id_is_uuid_v4_urn_in_authorization() {
        let directory = std::env::temp_dir().join(format!("vegsnap-host-test-{}", random_value()));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("host-id");
        let host = host_id_at(&path).unwrap();
        let persisted = host_id_at(&path).unwrap();
        fs::remove_dir_all(directory).unwrap();
        assert_eq!(host, persisted);
        let url = authorization_url(
            &host,
            BOOTSTRAP,
            "http://127.0.0.1:3210/auth/callback",
            "state",
            "nonce",
            "verifier",
        );
        let params: HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(params["ext_agent_host_id"], host);
        assert!(
            host.starts_with("urn:uuid:"),
            "ext_agent_host_id must be a UUID URN, not an arbitrary opaque string"
        );
        let uuid = &host[9..];
        assert_eq!(uuid.len(), 36);
        assert_eq!(&uuid[14..15], "4");
        assert!(matches!(&uuid[19..20], "8" | "9" | "a" | "b"));
        assert_eq!(uuid.chars().filter(|c| *c == '-').count(), 4);
    }

    #[test]
    fn invalid_saved_host_id_is_rejected_without_replacement() {
        let directory = std::env::temp_dir().join(format!("vegsnap-host-test-{}", random_value()));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("host-id");
        fs::write(&path, "old-invalid-opaque-id").unwrap();
        let result = host_id_at(&path);
        let unchanged = fs::read_to_string(&path).unwrap();
        fs::remove_dir_all(directory).unwrap();
        assert!(
            result.is_err(),
            "invalid host ID must fail before opening the authorization browser"
        );
        assert_eq!(unchanged, "old-invalid-opaque-id");
    }

    #[test]
    fn saved_uuid_is_preserved_and_malformed_uuids_are_rejected() {
        let valid = "urn:uuid:8fd8cd3c-55d9-4a22-90aa-c42f0ea92bab";
        let directory = std::env::temp_dir().join(format!("vegsnap-host-test-{}", random_value()));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("host-id");
        fs::write(&path, valid).unwrap();
        let loaded = host_id_at(&path).unwrap();
        fs::remove_dir_all(directory).unwrap();
        assert_eq!(valid, loaded);
        for invalid in [
            "",
            "urn:uuid:8fd8cd3c-55d9-1a22-90aa-c42f0ea92bab",
            "urn:uuid:8fd8cd3c-55d9-4a22-10aa-c42f0ea92bab",
            "urn:uuid:8fd8cd3c55d94a2290aac42f0ea92bab",
            "urn:uuid:8fd8cd3c-55d9-4a22-90aa-c42f0ea92bab\n",
        ] {
            assert!(!valid_host_id(invalid));
        }
    }

    // Public, generated test-only key. It is never used for real authentication.
    fn test_token(claims: Value) -> String {
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some("local-test-key".into());
        encode(
            &header,
            &claims,
            &EncodingKey::from_rsa_der(
                &base64::engine::general_purpose::STANDARD
                    .decode(
                        include_str!("../test-data/identity-test-key.pem")
                            .lines()
                            .filter(|line| !line.starts_with("---"))
                            .collect::<String>(),
                    )
                    .unwrap(),
            ),
        )
        .unwrap()
    }

    fn test_claims() -> Value {
        json!({"sub":"test-account","email":"test@example.invalid","iss":ISSUER,"aud":"issued-client","nonce":"expected-nonce","exp":now()+3600})
    }

    fn test_keys() -> JwkSet {
        serde_json::from_str(include_str!("../test-data/identity-test-jwks.json")).unwrap()
    }

    #[test]
    fn verifies_identity_signature_and_sign_in_claims() {
        let token = test_token(test_claims());
        let identity = validate_identity_with_keys(
            &token,
            "issued-client",
            Some("expected-nonce"),
            &test_keys(),
        )
        .unwrap();
        assert_eq!(identity.sub, "test-account");
        assert!(
            validate_identity_with_keys(
                &token,
                "other-client",
                Some("expected-nonce"),
                &test_keys()
            )
            .is_err()
        );
        assert!(
            validate_identity_with_keys(&token, "issued-client", Some("other-nonce"), &test_keys())
                .is_err()
        );
        assert!(
            validate_identity_with_keys(
                &token,
                "issued-client",
                Some("expected-nonce"),
                &JwkSet { keys: vec![] }
            )
            .is_err()
        );
        for (field, value) in [
            ("iss", json!("https://wrong.example")),
            ("exp", json!(now() - 60)),
            ("sub", json!("")),
            ("nonce", Value::Null),
            ("nbf", json!(now() + 3600)),
        ] {
            let mut claims = test_claims();
            claims[field] = value;
            assert!(
                validate_identity_with_keys(
                    &test_token(claims),
                    "issued-client",
                    Some("expected-nonce"),
                    &test_keys()
                )
                .is_err(),
                "must reject invalid {field}"
            );
        }
    }

    #[test]
    fn rejects_modified_signatures_and_unsupported_algorithms() {
        let token = test_token(test_claims());
        let (signed, signature) = token.rsplit_once('.').unwrap();
        let mut signature = URL_SAFE_NO_PAD.decode(signature).unwrap();
        signature[0] ^= 1;
        let changed = format!("{signed}.{}", URL_SAFE_NO_PAD.encode(signature));
        assert!(
            validate_identity_with_keys(
                &changed,
                "issued-client",
                Some("expected-nonce"),
                &test_keys()
            )
            .is_err()
        );
        let mut header = Header::new(Algorithm::HS256);
        header.kid = Some("local-test-key".into());
        let unsupported = encode(
            &header,
            &test_claims(),
            &EncodingKey::from_secret(b"public-test-secret"),
        )
        .unwrap();
        assert!(
            validate_identity_with_keys(
                &unsupported,
                "issued-client",
                Some("expected-nonce"),
                &test_keys()
            )
            .is_err()
        );
    }

    #[test]
    fn validates_every_photo_and_keeps_all_three() {
        let photos = vec!["data:image/png;base64,AQID".to_string(); 3];
        let (_, content) = check_content(CheckPayload {
            model: "vision".into(),
            text: "label".into(),
            image_data_urls: photos,
        })
        .unwrap();
        assert_eq!(content.len(), 4);
        for photos in [
            vec!["https://example.invalid/image".into()],
            vec!["data:image/png;base64,!!!".into()],
            vec!["data:image/png;base64,".into()],
            vec!["data:image/png;base64,AQID".into(); 4],
        ] {
            assert!(
                check_content(CheckPayload {
                    model: "vision".into(),
                    text: String::new(),
                    image_data_urls: photos
                })
                .is_err()
            );
        }
        assert!(
            check_content(CheckPayload {
                model: " ".into(),
                text: String::new(),
                image_data_urls: vec![]
            })
            .is_err()
        );
    }

    #[test]
    fn registration_subject_hash_preserves_sha256_lower_hex_format() {
        // These hashes are persisted between releases. In particular, leading zero
        // nibbles must survive dependency upgrades so the same account still matches.
        assert_eq!(
            subject_hash("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let registration = Registration {
            client_id: "issued-client".into(),
            subject_hash: Some(
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into(),
            ),
            email: None,
        };
        assert!(valid_registration(&registration));
        assert!(registration.accepts_subject("abc"));
        assert!(!registration.accepts_subject("abcd"));
    }

    #[test]
    fn oauth_random_values_keep_256_bits_and_url_safe_encoding() {
        fn requires_crypto_rng(_: &impl rand::CryptoRng) {}
        requires_crypto_rng(&rand::rng());
        let first = random_value();
        let second = random_value();
        for value in [&first, &second] {
            assert_eq!(value.len(), 43);
            assert!(
                value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
            );
            assert_eq!(URL_SAFE_NO_PAD.decode(value).unwrap().len(), 32);
        }
        assert_ne!(first, second);
    }

    #[test]
    fn pkce_matches_rfc7636_and_callback_uri_is_exact() {
        let url = authorization_url(
            "urn:uuid:8fd8cd3c-55d9-4a22-90aa-c42f0ea92bab",
            BOOTSTRAP,
            "http://127.0.0.1:4567/auth/callback",
            "state",
            "nonce",
            "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
        );
        let params: HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(
            params["code_challenge"],
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        assert_eq!(
            params["redirect_uri"],
            "http://127.0.0.1:4567/auth/callback"
        );
        assert_eq!(params["agent_name_hint"], "Vegsnap");
        let returning = authorization_url(
            "urn:uuid:8fd8cd3c-55d9-4a22-90aa-c42f0ea92bab",
            "issued",
            "http://127.0.0.1:4/auth/callback",
            "s",
            "n",
            "v",
        );
        assert!(!returning.query_pairs().any(|(k, _)| k == "agent_name_hint"));
    }

    #[test]
    fn callback_requires_state_and_issued_registration() {
        assert!(callback("/auth/callback?state=wrong&code=c&client_id=id", "s", None).is_err());
        assert!(callback("/callback?state=s&code=c&client_id=id", "s", None).is_err());
        assert!(callback("/auth/callback?state=s&code=c", "s", None).is_err());
        assert!(
            callback(
                "/auth/callback?state=s&code=c&client_id=dynamic_agent_client",
                "s",
                None
            )
            .is_err()
        );
        assert!(
            callback(
                "/auth/callback?state=s&state=s&code=c&client_id=id",
                "s",
                None
            )
            .is_err()
        );
        assert_eq!(
            callback("/auth/callback?state=s&code=c&client_id=id", "s", None).unwrap(),
            ("c".into(), "id".into())
        );
    }

    #[test]
    fn returning_callback_cannot_replace_account_registration() {
        assert!(
            callback(
                "/auth/callback?state=s&code=c&client_id=other",
                "s",
                Some("original")
            )
            .is_err()
        );
        assert_eq!(
            callback("/auth/callback?state=s&code=c", "s", Some("original"))
                .unwrap()
                .1,
            "original"
        );
        assert!(callback("/auth/callback?state=s&error=access_denied", "s", None).is_err());
    }

    #[test]
    fn identity_only_scope_does_not_allow_inference() {
        let mut tokens = Tokens {
            access_token: "token".into(),
            refresh_token: None,
            id_token: None,
            token_type: "Bearer".into(),
            expires_in: 3600,
            scope: Some("openid email".into()),
        };
        assert!(validate_tokens(&tokens, None).is_err());
        tokens.scope = Some(SCOPE.into());
        assert!(validate_tokens(&tokens, None).is_ok());
        tokens.scope = None;
        assert!(validate_tokens(&tokens, None).is_err());
        assert!(validate_tokens(&tokens, Some(&["chatgpt.tokens.use.direct".into()])).is_ok());
    }
}
