//! `zubra-sync`: the log that `'use collection'` devices share, as one binary.
//!
//! It speaks the same HTTP protocol as `@zubra/sync/server` (docs/sync.md), and keeps the log in
//! the same SQLite tables as `sqliteLog()`, so the two are interchangeable, file included:
//!
//!   POST /_zb/sync/push      { changes: [Change] }            → { ok: true }
//!   GET  /_zb/sync/pull?since=<cursor>[&scope=<json>]         → { changes, cursor }
//!   GET  /_zb/sync/live?since=<cursor>&peer=<id>[&key=…][&scope=…] → server-sent events: hello, changes, presence
//!   POST /_zb/sync/presence  { room, peer, state | null, key }  → { ok: true }
//!
//! A peer id belongs to the live stream holding it: its `hello` event carries a secret `key`,
//! which presence and signals sent as that peer must carry, and which a reconnect presents to
//! keep the peer id (as `@zubra/sync/server`).
//!
//! It has no notion of users: run it behind the app (a reverse proxy at `/_zb/sync`, after the
//! app's own sign-in) or on a trusted network. Pages read nothing until it's told what they may
//! (`--read <collection>`, `--read-all`) and write nothing without `--open`, which opens both. Posts from a browser are accepted only from the
//! binary's own origin and the `--origin`s given, which also get CORS headers.

use rusqlite::{params, Connection, TransactionBehavior};
use serde_json::{json, Value};
use std::collections::hash_map::RandomState;
use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasher, Hasher};
use std::io::{Read, Write};
use std::sync::mpsc::{sync_channel, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

const MOUNT: &str = "/_zb/sync";
const PAGE: i64 = 1000;
const MAX_BODY: u64 = 1 << 20;
const MAX_PENDING_EVENTS: usize = 16;

struct Options {
    db: String,
    keep_latest: bool,
    host: String,
    port: u16,
    origins: Vec<String>,
    keep_alive: Duration,
    /// Take reads and writes from pages. Off by default: the binary can't tell who is asking.
    open: bool,
    /// What pages may read without `--open`: nothing by default.
    reads: Reads,
}

/// The collections pages may read, as `@zubra/sync/server`'s `authorize`: nothing unless told
/// (`allowReads([…])` there, `--read <collection>` here; `allowReads()`, `--read-all`).
#[derive(Clone)]
enum Reads {
    Nothing,
    Everything,
    Only(HashSet<String>),
}

impl Reads {
    fn allows(&self, collection: &str) -> bool {
        match self {
            Reads::Nothing => false,
            Reads::Everything => true,
            Reads::Only(collections) => collections.contains(collection),
        }
    }
}

fn options() -> Result<Options, String> {
    let mut options = Options {
        db: "sync.db".into(),
        keep_latest: false,
        host: "127.0.0.1".into(),
        port: 4000,
        origins: Vec::new(),
        keep_alive: Duration::from_secs(15),
        open: false,
        reads: Reads::Nothing,
    };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mut value = |name: &str| args.next().ok_or(format!("{name} needs a value"));
        match arg.as_str() {
            "--db" => options.db = value("--db")?,
            "--keep-latest" => options.keep_latest = true,
            "--host" => options.host = value("--host")?,
            "--port" => {
                options.port = value("--port")?
                    .parse()
                    .map_err(|_| "--port takes a number".to_string())?
            }
            "--origin" => options.origins.push(value("--origin")?),
            "--open" => options.open = true,
            "--read-all" => options.reads = Reads::Everything,
            "--read" => {
                let collection = value("--read")?;
                match &mut options.reads {
                    Reads::Everything => {}
                    Reads::Only(collections) => {
                        collections.insert(collection);
                    }
                    Reads::Nothing => options.reads = Reads::Only(HashSet::from([collection])),
                }
            }
            "--keep-alive" => {
                options.keep_alive = Duration::from_millis(
                    value("--keep-alive")?
                        .parse()
                        .map_err(|_| "--keep-alive takes milliseconds".to_string())?,
                )
            }
            "-h" | "--help" => {
                println!("usage: zubra-sync [--db sync.db] [--keep-latest] [--host 127.0.0.1] [--port 4000] [--origin https://app.example]... [--keep-alive 15000] [--read <collection>]... [--read-all] [--open]");
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument {other} (try --help)")),
        }
    }
    if options.open {
        options.reads = Reads::Everything;
    }
    Ok(options)
}

/// One live subscriber: where to send its events, and the rooms its peer is in.
struct Listener {
    id: u64,
    peer: String,
    /// The secret that proves a request speaks for `peer` (sent in the stream's `hello`).
    key: String,
    rooms: HashSet<String>,
    /// What the page asked for (`?scope=`); None is everything.
    scope: Option<Value>,
    events: Option<SyncSender<String>>,
}

struct State {
    db: Mutex<Connection>,
    keep_latest: bool,
    listeners: Mutex<Vec<Listener>>,
    /// Peers whose stream ended, with its key and until when only that key may take the id back:
    /// otherwise whoever asked first in the gap would take it, and be sent its signals.
    released: Mutex<HashMap<String, (String, Instant)>>,
    next: Mutex<u64>,
    origins: Vec<String>,
    keep_alive: Duration,
    open: bool,
    reads: Reads,
}

/// What a page is told when the binary wasn't started with --open.
const NOT_OPEN: &str = "This sync server takes no reads or writes from pages until it is told who may access them: start zubra-sync with --open, behind your app's own sign-in (see its README).";

fn main() {
    let options = match options() {
        Ok(options) => options,
        Err(error) => {
            eprintln!("zubra-sync: {error}");
            std::process::exit(2);
        }
    };
    let mut db = Connection::open(&options.db).unwrap_or_else(|error| {
        eprintln!("zubra-sync: can't open {}: {error}", options.db);
        std::process::exit(1);
    });
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS changes (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            collection TEXT NOT NULL,
            key TEXT NOT NULL,
            field TEXT NOT NULL,
            value TEXT,
            clock TEXT NOT NULL
        )",
    )
    .expect("create the changes table");
    if options.keep_latest {
        init_latest(&mut db).expect("create the latest log");
    }
    let address = format!("{}:{}", options.host, options.port);
    let server = Server::http(&address).unwrap_or_else(|error| {
        eprintln!("zubra-sync: can't listen on {address}: {error}");
        std::process::exit(1);
    });
    // The port actually bound (for --port 0), so a test or a supervisor can find it.
    println!(
        "zubra-sync listening on http://{} (log: {})",
        server.server_addr(),
        options.db
    );
    if matches!(options.reads, Reads::Nothing) {
        eprintln!("zubra-sync: pages may read nothing: start it with --read <collection> (repeatable), --read-all, or --open (see its README)");
    }
    let state = Arc::new(State {
        db: Mutex::new(db),
        keep_latest: options.keep_latest,
        listeners: Mutex::new(Vec::new()),
        released: Mutex::new(HashMap::new()),
        next: Mutex::new(0),
        origins: options.origins,
        keep_alive: options.keep_alive,
        open: options.open,
        reads: options.reads,
    });
    for request in server.incoming_requests() {
        let state = Arc::clone(&state);
        std::thread::spawn(move || handle(&state, request));
    }
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("a valid header")
}

fn request_header<'a>(request: &'a Request, name: &'static str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv(name))
        .map(|header| header.value.as_str())
}

/// CORS for the allowed origins (so a page on another origin can use the binary directly).
fn cors(state: &State, request: &Request) -> Vec<Header> {
    match request_header(request, "origin") {
        Some(origin) if state.origins.iter().any(|allowed| allowed == origin) => vec![
            header("access-control-allow-origin", origin),
            header("access-control-allow-headers", "content-type"),
            header("access-control-allow-methods", "GET, POST, OPTIONS"),
            header("vary", "origin"),
        ],
        _ => Vec::new(),
    }
}

/// A browser post must come from this origin or an allowed one. No Origin: not a browser.
fn origin_allowed(state: &State, request: &Request) -> bool {
    let Some(origin) = request_header(request, "origin") else {
        return true;
    };
    let host = request_header(request, "host").unwrap_or_default();
    origin == format!("http://{host}")
        || origin == format!("https://{host}")
        || state.origins.iter().any(|allowed| allowed == origin)
}

fn respond_json(request: Request, extra: Vec<Header>, status: u16, value: Value) {
    let mut response = Response::from_string(value.to_string())
        .with_status_code(StatusCode(status))
        .with_header(header("content-type", "application/json"));
    for each in extra {
        response.add_header(each);
    }
    let _ = request.respond(response);
}

fn query<'a>(url: &'a str, name: &str) -> Option<&'a str> {
    let (_, query) = url.split_once('?')?;
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        (key == name).then_some(value)
    })
}

/// `%xx` and `+` in a query value, as `encodeURIComponent` and forms write them.
fn decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'%' => {
                let hex = std::str::from_utf8(bytes.get(at + 1..at + 3)?).ok()?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                at += 3;
            }
            b'+' => {
                out.push(b' ');
                at += 1;
            }
            byte => {
                out.push(byte);
                at += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

/// The page's `?scope=` (docs/sync.md): `{ collection: true | "prefix" | ["prefixes"] }`.
/// `Ok(None)` when there's none (or it's `null`), `Err` when it isn't one.
fn scope_of(url: &str) -> Result<Option<Value>, ()> {
    let Some(raw) = query(url, "scope").filter(|raw| !raw.is_empty()) else {
        return Ok(None);
    };
    let scope: Value = decode(raw)
        .and_then(|text| serde_json::from_str(&text).ok())
        .ok_or(())?;
    if scope.is_null() {
        return Ok(None);
    }
    let prefix = |each: &Value| each.as_str().is_some_and(|text| text.len() <= 200);
    let ok = scope.as_object().is_some_and(|rules| {
        rules.len() <= 100
            && rules.values().all(|rule| {
                rule == &Value::Bool(true)
                    || prefix(rule)
                    || rule
                        .as_array()
                        .is_some_and(|list| list.len() <= 50 && list.iter().all(prefix))
            })
    });
    if ok {
        Ok(Some(scope))
    } else {
        Err(())
    }
}

/// Whether a document is in a scope (None is everything).
fn in_scope(scope: &Option<Value>, collection: &str, key: &str) -> bool {
    let Some(scope) = scope else { return true };
    match scope.get(collection) {
        Some(Value::Bool(true)) => true,
        Some(Value::String(prefix)) => key.starts_with(prefix.as_str()),
        Some(Value::Array(list)) => list.iter().any(|prefix| {
            prefix
                .as_str()
                .is_some_and(|prefix| key.starts_with(prefix))
        }),
        _ => false,
    }
}

/// The changes a scope lets through, of the collections pages may read.
fn scoped(reads: &Reads, scope: &Option<Value>, changes: &[Value]) -> Vec<Value> {
    changes
        .iter()
        .filter(|change| {
            let collection = change["collection"].as_str().unwrap_or_default();
            reads.allows(collection)
                && in_scope(
                    scope,
                    collection,
                    change["key"].as_str().unwrap_or_default(),
                )
        })
        .cloned()
        .collect()
}

const BAD_SCOPE: &str = "scope is { collection: true | \"key prefix\" | [\"prefixes\"] }";

fn read_json(request: &mut Request) -> Option<Value> {
    let mut body = String::new();
    request
        .as_reader()
        .take(MAX_BODY)
        .read_to_string(&mut body)
        .ok()?;
    serde_json::from_str(&body).ok()
}

fn handle(state: &State, mut request: Request) {
    let url = request.url().to_owned();
    let path = url.split('?').next().unwrap_or_default().to_owned();
    let extra = cors(state, &request);
    if !path.starts_with(&format!("{MOUNT}/")) {
        return respond_json(request, extra, 404, json!({ "error": "Not found" }));
    }
    let route = &path[MOUNT.len()..];
    if matches!(state.reads, Reads::Nothing)
        && request.method() == &Method::Get
        && matches!(route, "/pull" | "/live")
    {
        return respond_json(request, extra, 403, json!({ "error": NOT_OPEN }));
    }
    match (request.method().clone(), route) {
        (Method::Options, _) => {
            let mut response = Response::empty(StatusCode(204));
            for each in extra {
                response.add_header(each);
            }
            let _ = request.respond(response);
        }
        (Method::Post, "/push") => {
            if !origin_allowed(state, &request) {
                return respond_json(
                    request,
                    extra,
                    403,
                    json!({ "error": "Cross-site writes are refused" }),
                );
            }
            if !state.open {
                return respond_json(request, extra, 403, json!({ "error": NOT_OPEN }));
            }
            let Some(changes) = read_json(&mut request)
                .and_then(|body| body.get("changes").cloned())
                .and_then(|changes| changes.as_array().cloned())
                .filter(|changes| changes.iter().all(valid_change))
            else {
                return respond_json(
                    request,
                    extra,
                    400,
                    json!({ "error": "Expected { changes: [{ collection, key, field, value, clock }] }; a field can't be named key, $clocks, or a name every object has (__proto__, constructor, toString…)" }),
                );
            };
            // As @zubra/sync/server's default `maxChanges`: connect() sends batches under it.
            if changes.len() > MAX_CHANGES {
                return respond_json(
                    request,
                    extra,
                    413,
                    json!({ "error": format!("A push carries at most {MAX_CHANGES} changes; send them in smaller batches") }),
                );
            }
            if changes.iter().any(clock_ahead) {
                return respond_json(
                    request,
                    extra,
                    400,
                    json!({ "error": "A change's clock is ahead of the server's by more than 60 s; check the device's time" }),
                );
            }
            let cursor = match append(state, &changes) {
                Ok(cursor) => cursor,
                Err(error) => {
                    eprintln!("zubra-sync: {error}");
                    return respond_json(
                        request,
                        extra,
                        500,
                        json!({ "error": "Couldn't write the log" }),
                    );
                }
            };
            let cleaned: Vec<Value> = changes.iter().map(clean_change).collect();
            broadcast_changes(state, &cleaned, cursor);
            respond_json(request, extra, 200, json!({ "ok": true }));
        }
        (Method::Get, "/pull") => {
            let Ok(scope) = scope_of(&url) else {
                return respond_json(request, extra, 400, json!({ "error": BAD_SCOPE }));
            };
            let (since, reset) = start_from(
                state,
                query(&url, "since")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0),
            );
            match after(state, since) {
                Ok((changes, cursor)) => {
                    let mut body = json!({ "changes": scoped(&state.reads, &scope, &changes), "cursor": cursor });
                    if reset {
                        body["reset"] = json!(true);
                    }
                    respond_json(request, extra, 200, body)
                }
                Err(error) => {
                    eprintln!("zubra-sync: {error}");
                    respond_json(
                        request,
                        extra,
                        500,
                        json!({ "error": "Couldn't read the log" }),
                    )
                }
            }
        }
        (Method::Post, "/presence") => {
            if !origin_allowed(state, &request) {
                return respond_json(
                    request,
                    extra,
                    403,
                    json!({ "error": "Cross-site writes are refused" }),
                );
            }
            if !state.open {
                return respond_json(request, extra, 403, json!({ "error": NOT_OPEN }));
            }
            let Some(message) = read_json(&mut request).filter(valid_presence) else {
                return respond_json(
                    request,
                    extra,
                    400,
                    json!({ "error": "Expected { room: \"<collection>/<key>\", peer, state: {…} | null }" }),
                );
            };
            let room = message["room"].as_str().unwrap_or_default().to_owned();
            let peer = message["peer"].as_str().unwrap_or_default().to_owned();
            if !speaks_as(state, &peer, message["key"].as_str(), false) {
                return respond_json(request, extra, 403, json!({ "error": NOT_YOUR_PEER }));
            }
            let clean = json!({ "room": room, "peer": peer, "state": message["state"] });
            {
                let mut listeners = state.listeners.lock().expect("listeners");
                for listener in listeners
                    .iter_mut()
                    .filter(|listener| listener.peer == peer)
                {
                    if message["state"].is_null() {
                        listener.rooms.remove(&room);
                    } else {
                        listener.rooms.insert(room.clone());
                    }
                }
            }
            broadcast_presence(state, &clean, &peer);
            respond_json(request, extra, 200, json!({ "ok": true }));
        }
        (Method::Post, "/signal") => {
            // WebRTC signaling for one peer, passed on to that peer's live stream.
            if !origin_allowed(state, &request) {
                return respond_json(
                    request,
                    extra,
                    403,
                    json!({ "error": "Cross-site writes are refused" }),
                );
            }
            if !state.open {
                return respond_json(request, extra, 403, json!({ "error": NOT_OPEN }));
            }
            let Some(message) = read_json(&mut request).filter(valid_signal) else {
                return respond_json(
                    request,
                    extra,
                    400,
                    json!({ "error": "Expected { room, from, to, data: {…} }" }),
                );
            };
            let from = message["from"].as_str().unwrap_or_default();
            if !speaks_as(state, from, message["key"].as_str(), true) {
                return respond_json(request, extra, 403, json!({ "error": NOT_YOUR_PEER }));
            }
            let to = message["to"].as_str().unwrap_or_default().to_owned();
            let room = message["room"].as_str().unwrap_or_default();
            let (collection, key) = room.split_once('/').unwrap_or((room, ""));
            let clean = json!({ "room": message["room"], "from": message["from"], "to": to, "data": message["data"] });
            let text = event("signal", &clean);
            // Only to a recipient whose own scope lets it into the room.
            for listener in state.listeners.lock().expect("listeners").iter_mut() {
                if listener.peer == to
                    && state.reads.allows(collection)
                    && in_scope(&listener.scope, collection, key)
                {
                    enqueue(listener, text.clone());
                }
            }
            respond_json(request, extra, 200, json!({ "ok": true }));
        }
        (Method::Get, "/live") => live(state, request, &url, extra),
        _ => respond_json(request, extra, 404, json!({ "error": "Not found" })),
    }
}

fn valid_change(change: &Value) -> bool {
    let text = |name: &str| change.get(name).and_then(Value::as_str);
    let clock_ok = text("clock").is_some_and(|clock| {
        let parts: Vec<&str> = clock.splitn(3, '-').collect();
        parts.len() == 3
            && parts[0].len() == 15
            && parts[0].bytes().all(|b| b.is_ascii_digit())
            && parts[1].len() == 5
            && parts[1].bytes().all(|b| b.is_ascii_digit())
            && !parts[2].is_empty()
            && parts[2]
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    });
    text("collection").is_some()
        && text("key").is_some()
        && text("field").is_some_and(|field| {
            field != "$clocks" && field != "key" && !INHERITED.contains(&field)
        })
        && clock_ok
}

/// The names every JavaScript object already has, plus `prototype`: documents are plain objects
/// on every device, so `__proto__` would set a document's prototype and the rest would never be
/// applied. `prototype` is not on `Object.prototype`; a merge that walks `constructor.prototype`
/// must not find a field there either.
const INHERITED: [&str; 13] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
    "prototype",
];

/// How far ahead of this server's clock a pushed change's clock may be (the JavaScript server's
/// default `maxSkew`). Further ahead would win every merge for ever.
const MAX_SKEW_MS: u128 = 60_000;

/// Whether a (valid) change's clock is more than [`MAX_SKEW_MS`] ahead of now.
fn clock_ahead(change: &Value) -> bool {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis());
    change["clock"]
        .as_str()
        .and_then(|clock| clock.get(..15))
        .and_then(|time| time.parse::<u128>().ok())
        .is_some_and(|time| time > now + MAX_SKEW_MS)
}

fn clean_change(change: &Value) -> Value {
    json!({
        "collection": change["collection"],
        "key": change["key"],
        "field": change["field"],
        "value": change.get("value").cloned().unwrap_or(Value::Null),
        "clock": change["clock"],
    })
}

fn valid_presence(message: &Value) -> bool {
    let room_ok = message
        .get("room")
        .and_then(Value::as_str)
        .is_some_and(|room| room.find('/').is_some_and(|at| at > 0));
    let peer_ok = message
        .get("peer")
        .and_then(Value::as_str)
        .is_some_and(|peer| {
            !peer.is_empty()
                && peer.len() <= 40
                && peer
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        });
    let state = message.get("state").unwrap_or(&Value::Null);
    let state_ok = (state.is_null() || state.is_object()) && state.to_string().len() <= 4096;
    room_ok && peer_ok && state_ok
}

fn peer_ok(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|peer| {
        !peer.is_empty()
            && peer.len() <= 40
            && peer
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}

fn valid_signal(message: &Value) -> bool {
    let room_ok = message
        .get("room")
        .and_then(Value::as_str)
        .is_some_and(|room| room.find('/').is_some_and(|at| at > 0));
    let data_ok = message
        .get("data")
        .is_some_and(|data| data.is_object() && data.to_string().len() <= 16384);
    room_ok && peer_ok(message.get("from")) && peer_ok(message.get("to")) && data_ok
}

fn init_latest(db: &mut Connection) -> rusqlite::Result<()> {
    let transaction = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let exists: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'latest')",
        [],
        |row| row.get(0),
    )?;
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS latest (
            collection TEXT NOT NULL,
            key TEXT NOT NULL,
            field TEXT NOT NULL,
            value TEXT,
            clock TEXT NOT NULL,
            seq INTEGER NOT NULL UNIQUE,
            PRIMARY KEY (collection, key, field)
        )",
    )?;
    if !exists {
        transaction.execute_batch(
            "INSERT INTO latest (collection, key, field, value, clock, seq)
             SELECT collection, key, field, value, clock,
                    (SELECT COALESCE(MAX(seq), 0) FROM changes) + ROW_NUMBER() OVER (ORDER BY seq)
             FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY collection, key, field ORDER BY clock DESC, seq DESC) AS rank FROM changes)
             WHERE rank = 1",
        )?;
    }
    transaction.commit()
}

fn head_sql(keep_latest: bool) -> &'static str {
    if keep_latest {
        "SELECT COALESCE(MAX(seq), 0) FROM latest"
    } else {
        "SELECT COALESCE(MAX(seq), 0) FROM changes"
    }
}

fn append(state: &State, changes: &[Value]) -> rusqlite::Result<i64> {
    let mut db = state.db.lock().expect("db");
    let transaction = db.transaction()?;
    {
        let sql = if state.keep_latest {
            "INSERT INTO latest (collection, key, field, value, clock, seq)
             VALUES (?1, ?2, ?3, ?4, ?5, (SELECT COALESCE(MAX(seq), 0) + 1 FROM latest))
             ON CONFLICT (collection, key, field) DO UPDATE SET value = excluded.value, clock = excluded.clock, seq = excluded.seq
             WHERE excluded.clock > latest.clock"
        } else {
            "INSERT INTO changes (collection, key, field, value, clock) VALUES (?1, ?2, ?3, ?4, ?5)"
        };
        let mut insert = transaction.prepare_cached(sql)?;
        for change in changes {
            insert.execute(params![
                change["collection"].as_str(),
                change["key"].as_str(),
                change["field"].as_str(),
                change
                    .get("value")
                    .cloned()
                    .unwrap_or(Value::Null)
                    .to_string(),
                change["clock"].as_str(),
            ])?;
        }
    }
    transaction.commit()?;
    db.query_row(head_sql(state.keep_latest), [], |row| row.get(0))
}

/// Where to read from for a device at `since`: from the start, and say so, if it's past the end of
/// the log (the log was replaced, or the device's cursor is from another one).
fn start_from(state: &State, since: i64) -> (i64, bool) {
    let head: i64 = state
        .db
        .lock()
        .expect("db")
        .query_row(head_sql(state.keep_latest), [], |row| row.get(0))
        .unwrap_or(0);
    if since > head {
        (0, true)
    } else {
        (since, false)
    }
}

fn after(state: &State, since: i64) -> rusqlite::Result<(Vec<Value>, i64)> {
    let db = state.db.lock().expect("db");
    let sql = if state.keep_latest {
        "SELECT seq, collection, key, field, value, clock FROM latest WHERE seq > ?1 ORDER BY seq LIMIT ?2"
    } else {
        "SELECT seq, collection, key, field, value, clock FROM changes WHERE seq > ?1 ORDER BY seq LIMIT ?2"
    };
    let mut select = db.prepare_cached(sql)?;
    let mut cursor = since;
    let rows = select.query_map(params![since, PAGE], |row| {
        let seq: i64 = row.get(0)?;
        let value: Option<String> = row.get(4)?;
        Ok((
            seq,
            json!({
                "collection": row.get::<_, String>(1)?,
                "key": row.get::<_, String>(2)?,
                "field": row.get::<_, String>(3)?,
                "value": value.and_then(|text| serde_json::from_str::<Value>(&text).ok()).unwrap_or(Value::Null),
                "clock": row.get::<_, String>(5)?,
            }),
        ))
    })?;
    let mut changes = Vec::new();
    for row in rows {
        let (seq, change) = row?;
        cursor = seq;
        changes.push(change);
    }
    Ok((changes, cursor))
}

/// The most changes one push may carry.
const MAX_CHANGES: usize = 1000;

const NOT_YOUR_PEER: &str = "That peer id is another viewer's";

/// Whether a request carrying `key` speaks for `peer`: the key of the stream holding it, or any
/// key when no stream holds it (unless `held`, for a signal, which needs a stream to answer to).
fn speaks_as(state: &State, peer: &str, key: Option<&str>, held: bool) -> bool {
    let listeners = state.listeners.lock().expect("listeners");
    match listeners.iter().find(|listener| listener.peer == peer) {
        Some(listener) => key == Some(listener.key.as_str()),
        None => match released_key(state, peer) {
            Some(kept) => key == Some(kept.as_str()),
            None => !held,
        },
    }
}

/// How long a peer whose stream ended keeps its id for a reconnect with its key.
const RECONNECT: Duration = Duration::from_secs(60);

/// The key of `peer`'s stream that ended within the grace, if one did.
fn released_key(state: &State, peer: &str) -> Option<String> {
    let mut released = state.released.lock().expect("released");
    let now = Instant::now();
    released.retain(|_, (_, until)| *until > now);
    released.get(peer).map(|(key, _)| key.clone())
}

/// A secret for a live stream: 128 bits from the standard library's randomly keyed hasher.
fn new_key() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    (0..2u64)
        .map(|part| {
            let mut hasher = RandomState::new().build_hasher();
            hasher.write_u64(part);
            hasher.write_u128(nanos);
            format!("{:016x}", hasher.finish())
        })
        .collect()
}

fn event(name: &str, data: &Value) -> String {
    format!("event: {name}\ndata: {data}\n\n")
}

fn enqueue(listener: &mut Listener, text: String) {
    if listener
        .events
        .as_ref()
        .is_some_and(|events| events.try_send(text).is_err())
    {
        eprintln!("zubra-sync: live stream fell behind; closing it to resume from its cursor");
        listener.events = None;
    }
}

/// Changes to every live page, each getting what its scope lets through. A page that may see
/// none of them hears nothing: an empty event (and its cursor) would tell it that another
/// business on the log just wrote. A slow stream closes and resumes from its last cursor.
fn broadcast_changes(state: &State, changes: &[Value], cursor: i64) {
    let mut listeners = state.listeners.lock().expect("listeners");
    for listener in listeners.iter_mut() {
        if listener.events.is_none() {
            continue;
        }
        let visible = scoped(&state.reads, &listener.scope, changes);
        if visible.is_empty() {
            continue;
        }
        let data = json!({ "changes": visible, "cursor": cursor });
        enqueue(listener, event("changes", &data));
    }
}

/// Presence to every other live page whose scope has the room's document.
fn broadcast_presence(state: &State, message: &Value, except_peer: &str) {
    let room = message["room"].as_str().unwrap_or_default();
    let (collection, key) = room.split_once('/').unwrap_or((room, ""));
    let text = event("presence", message);
    let mut listeners = state.listeners.lock().expect("listeners");
    for listener in listeners.iter_mut() {
        if listener.peer != except_peer
            && state.reads.allows(collection)
            && in_scope(&listener.scope, collection, key)
        {
            enqueue(listener, text.clone());
        }
    }
}

/// The live stream. Subscribe first, then send the backlog page by page, so nothing pushed in
/// between is missed (a change may come twice; applying one twice changes nothing).
fn live(state: &State, request: Request, url: &str, extra: Vec<Header>) {
    let peer = query(url, "peer").unwrap_or_default().to_owned();
    if peer.len() > 40
        || !peer
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return respond_json(request, extra, 400, json!({ "error": "Bad peer id" }));
    }
    let Ok(scope) = scope_of(url) else {
        return respond_json(request, extra, 400, json!({ "error": BAD_SCOPE }));
    };
    let (events, receiver) = sync_channel(MAX_PENDING_EVENTS);
    let id = {
        let mut next = state.next.lock().expect("next");
        *next += 1;
        *next
    };
    let key = {
        let mut listeners = state.listeners.lock().expect("listeners");
        // A held peer id goes to a new stream only with the old one's key (a reconnect), which
        // replaces it quietly: its rooms and key carry over, and no goodbye is sent.
        let held = listeners
            .iter()
            .position(|listener| !peer.is_empty() && listener.peer == peer);
        let (key, rooms) = match held {
            Some(at) if query(url, "key") == Some(listeners[at].key.as_str()) => {
                let previous = listeners.remove(at);
                (previous.key, previous.rooms)
            }
            Some(_) => (String::new(), HashSet::new()),
            None => match released_key(state, &peer) {
                Some(kept) if query(url, "key") == Some(kept.as_str()) => (kept, HashSet::new()),
                Some(_) => (String::new(), HashSet::new()),
                None => (new_key(), HashSet::new()),
            },
        };
        if key.is_empty() {
            drop(listeners);
            return respond_json(
                request,
                extra,
                409,
                json!({ "error": "That peer id is another viewer's; pick another" }),
            );
        }
        if !peer.is_empty() {
            state.released.lock().expect("released").remove(&peer);
        }
        listeners.push(Listener {
            id,
            peer: peer.clone(),
            key: key.clone(),
            rooms,
            scope: scope.clone(),
            events: Some(events),
        });
        key
    };
    let (mut since, reset) = start_from(
        state,
        query(url, "since")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0),
    );
    // The response is written by hand, an event at a time, flushed as it goes: a stream with no
    // length that lasts until the client leaves. A keep-alive comment when it's quiet is also
    // how a client that has gone is noticed (the write fails).
    let mut head = String::from(
        "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-store\r\nconnection: close\r\n",
    );
    for each in &extra {
        head.push_str(&format!("{}: {}\r\n", each.field, each.value));
    }
    head.push_str("\r\n");
    let mut writer = request.into_writer();
    let mut send = |text: &[u8]| writer.write_all(text).and_then(|_| writer.flush()).is_ok();
    'stream: {
        if !send(head.as_bytes())
            || !send(b"retry: 1000\n\n")
            || !send(event("hello", &json!({ "key": key })).as_bytes())
        {
            break 'stream;
        }
        let mut first = true;
        loop {
            let (changes, cursor) = match after(state, since) {
                Ok(page) => page,
                Err(error) => {
                    eprintln!("zubra-sync: couldn't read the live backlog: {error}");
                    break 'stream;
                }
            };
            let empty = changes.is_empty();
            if empty && !first {
                break;
            }
            let mut data =
                json!({ "changes": scoped(&state.reads, &scope, &changes), "cursor": cursor });
            if reset && first {
                data["reset"] = json!(true);
            }
            first = false;
            if !send(event("changes", &data).as_bytes()) {
                break 'stream;
            }
            if empty || cursor == since {
                break;
            }
            since = cursor;
        }
        loop {
            let text = match receiver.recv_timeout(state.keep_alive) {
                Ok(text) => text,
                Err(RecvTimeoutError::Timeout) => ": keep-alive\n\n".to_owned(),
                Err(RecvTimeoutError::Disconnected) => break,
            };
            if !send(text.as_bytes()) {
                break;
            }
        }
    }
    let gone = {
        let mut listeners = state.listeners.lock().expect("listeners");
        let at = listeners.iter().position(|listener| listener.id == id);
        let gone = at.map(|at| listeners.remove(at));
        // Kept for its page to come back to, unless another stream with the key already has.
        if !peer.is_empty() && !listeners.iter().any(|listener| listener.peer == peer) {
            state
                .released
                .lock()
                .expect("released")
                .insert(peer.clone(), (key.clone(), Instant::now() + RECONNECT));
        }
        gone
    };
    if let Some(listener) = gone {
        for room in listener.rooms {
            broadcast_presence(
                state,
                &json!({ "room": room, "peer": peer, "state": null }),
                &peer,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::TryRecvError;

    #[test]
    fn slow_listener_is_disconnected_without_losing_its_peer_or_rooms() {
        let (events, receiver) = sync_channel(MAX_PENDING_EVENTS);
        let mut listener = Listener {
            id: 1,
            peer: "peer".into(),
            key: "key".into(),
            rooms: HashSet::from(["tasks/one".into()]),
            scope: None,
            events: Some(events),
        };
        for n in 0..MAX_PENDING_EVENTS {
            enqueue(&mut listener, n.to_string());
        }
        enqueue(&mut listener, "overflow".into());
        assert!(listener.events.is_none());
        assert!(listener.rooms.contains("tasks/one"));
        for n in 0..MAX_PENDING_EVENTS {
            assert_eq!(receiver.try_recv().unwrap(), n.to_string());
        }
        assert_eq!(receiver.try_recv(), Err(TryRecvError::Disconnected));
    }

    #[test]
    fn a_slow_listener_can_recover_missed_changes_from_its_last_cursor() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, key TEXT NOT NULL, field TEXT NOT NULL, value TEXT, clock TEXT NOT NULL)",
        ).unwrap();
        let (events, receiver) = sync_channel(MAX_PENDING_EVENTS);
        let state = State {
            db: Mutex::new(db),
            keep_latest: false,
            listeners: Mutex::new(vec![Listener {
                id: 1,
                peer: "peer".into(),
                key: "key".into(),
                rooms: HashSet::new(),
                scope: None,
                events: Some(events),
            }]),
            released: Mutex::new(HashMap::new()),
            next: Mutex::new(1),
            origins: Vec::new(),
            keep_alive: Duration::from_secs(15),
            open: true,
            reads: Reads::Everything,
        };
        for n in 0..=MAX_PENDING_EVENTS {
            let change = json!({ "collection": "tasks", "key": "one", "field": "v", "value": n, "clock": "000000000000001-00000-a" });
            let cursor = append(&state, std::slice::from_ref(&change)).unwrap();
            broadcast_changes(&state, &[change], cursor);
        }
        let mut cursor = 0;
        while let Ok(text) = receiver.try_recv() {
            let data = text
                .lines()
                .find_map(|line| line.strip_prefix("data: "))
                .unwrap();
            cursor = serde_json::from_str::<Value>(data).unwrap()["cursor"]
                .as_i64()
                .unwrap();
        }
        assert_eq!(cursor, MAX_PENDING_EVENTS as i64);
        assert_eq!(receiver.try_recv(), Err(TryRecvError::Disconnected));
        let (remaining, head) = after(&state, cursor).unwrap();
        assert_eq!(head, cursor + 1);
        assert_eq!(remaining[0]["value"], json!(MAX_PENDING_EVENTS));
    }
}
