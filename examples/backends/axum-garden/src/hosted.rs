//! The garden as a public demo (`HOSTED_DEMO=1`, as in deploy/axum-garden): strangers can write to
//! it, so it takes small bodies, a few writes a minute from each visitor and a bounded number of
//! records, and goes back to its seed data every `reset_minutes` (a day by default, at midnight
//! UTC). The same limits, answers and banner as the Flask example's `garden/hosted.py`.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{Html, IntoResponse, Response};

use crate::Store;

pub const NOTICE: &str = "Demo: data resets daily.";

/// Seconds since the Unix epoch.
pub type Clock = Arc<dyn Fn() -> f64 + Send + Sync>;

#[derive(Clone)]
pub struct Hosted {
    pub reset_minutes: f64,
    /// How many proxies in front append to `X-Forwarded-For` (Railway: one).
    pub trust_proxies: usize,
    pub writes_per_minute: u32,
    pub max_records: usize,
    pub max_bytes: usize,
    pub clock: Clock,
}

impl Default for Hosted {
    fn default() -> Self {
        Hosted {
            reset_minutes: 1440.0,
            trust_proxies: 0,
            writes_per_minute: 30,
            max_records: 500,
            max_bytes: 16 * 1024,
            clock: Arc::new(|| {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_secs_f64()
            }),
        }
    }
}

impl Hosted {
    /// Settings from the environment, or None when the garden isn't a hosted demo.
    pub fn from_env(env: impl Fn(&str) -> Option<String>) -> Option<Hosted> {
        if env("HOSTED_DEMO").as_deref() != Some("1") {
            return None;
        }
        let number = |name: &str, default: &str| {
            env(name)
                .unwrap_or_else(|| default.to_owned())
                .parse::<f64>()
                .unwrap_or_else(|_| panic!("{name} is not a number"))
        };
        Some(Hosted {
            reset_minutes: number("DEMO_RESET_MINUTES", "1440"),
            trust_proxies: number("TRUST_PROXIES", "0") as usize,
            ..Hosted::default()
        })
    }
}

/// What the guard keeps between requests.
pub(crate) struct Guard {
    hosted: Hosted,
    store: Arc<Mutex<Store>>,
    counts: Mutex<Counts>,
}

struct Counts {
    epoch: i64,
    minute: i64,
    writes: HashMap<String, u32>,
}

impl Guard {
    pub(crate) fn new(hosted: Hosted, store: Arc<Mutex<Store>>) -> Arc<Guard> {
        let epoch = ((hosted.clock)() / (hosted.reset_minutes * 60.0)).floor() as i64;
        Arc::new(Guard {
            hosted,
            store,
            counts: Mutex::new(Counts {
                epoch,
                minute: -1,
                writes: HashMap::new(),
            }),
        })
    }
}

/// The visitor's address is the entry the proxies in front appended to `X-Forwarded-For`, never
/// one the visitor wrote, so the write limit can't be dodged by sending the header. (Werkzeug's
/// ProxyFix, as the Flask example uses it.)
fn visitor(headers: &HeaderMap, socket: Option<SocketAddr>, trust_proxies: usize) -> String {
    if trust_proxies > 0 {
        let forwarded: Vec<String> = headers
            .get_all("x-forwarded-for")
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|value| value.split(','))
            .map(|entry| entry.trim().to_owned())
            .filter(|entry| !entry.is_empty())
            .collect();
        if forwarded.len() >= trust_proxies {
            return forwarded[forwarded.len() - trust_proxies].clone();
        }
    }
    socket
        .map(|address| address.ip().to_string())
        .unwrap_or_else(|| "unknown".to_owned())
}

pub(crate) async fn guard(
    State(guard): State<Arc<Guard>>,
    request: Request,
    next: Next,
) -> Response {
    match guard.check(&request) {
        Some(refusal) => refusal,
        None => next.run(request).await,
    }
}

impl Guard {
    /// The refusal for this request, if it gets one. Also where the data resets.
    fn check(&self, request: &Request) -> Option<Response> {
        let now = (self.hosted.clock)();
        let mut counts = self.counts.lock().unwrap();
        let epoch = (now / (self.hosted.reset_minutes * 60.0)).floor() as i64;
        if epoch != counts.epoch {
            counts.epoch = epoch;
            self.store.lock().unwrap().reset();
        }
        if request.method() != Method::POST {
            return None;
        }
        let minute = (now / 60.0).floor() as i64;
        if minute != counts.minute {
            counts.minute = minute;
            counts.writes.clear();
        }
        let socket = request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .map(|info| info.0);
        let who = visitor(request.headers(), socket, self.hosted.trust_proxies);
        let writes = counts.writes.entry(who).or_insert(0);
        *writes += 1;
        if *writes > self.hosted.writes_per_minute {
            return Some(
                (
                    StatusCode::TOO_MANY_REQUESTS,
                    [(header::RETRY_AFTER, "60")],
                    Html("Too many changes from here: try again in a minute."),
                )
                    .into_response(),
            );
        }
        drop(counts);
        // The plots are a fixed sixteen; the waitlist and the harvests grow, up to this many.
        if self.store.lock().unwrap().records() >= self.hosted.max_records {
            return Some(
                (
                    StatusCode::INSUFFICIENT_STORAGE,
                    Html("The demo holds no more until it resets (daily)."),
                )
                    .into_response(),
            );
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_visitor_is_the_proxys_entry_counting_from_the_end() {
        let socket: SocketAddr = "10.0.0.9:5000".parse().unwrap();
        let mut headers = HeaderMap::new();
        headers.append(
            "x-forwarded-for",
            "198.51.100.7, 203.0.113.1".parse().unwrap(),
        );
        headers.append("x-forwarded-for", "192.0.2.4".parse().unwrap());
        assert_eq!(visitor(&headers, Some(socket), 1), "192.0.2.4");
        assert_eq!(visitor(&headers, Some(socket), 2), "203.0.113.1");
        // Fewer entries than proxies: the header isn't the proxies', so the socket.
        assert_eq!(visitor(&headers, Some(socket), 4), "10.0.0.9");
        // No proxies trusted: the header is ignored.
        assert_eq!(visitor(&headers, Some(socket), 0), "10.0.0.9");
        assert_eq!(visitor(&HeaderMap::new(), None, 1), "unknown");
    }
}
