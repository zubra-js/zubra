//! The garden as a public demo (HOSTED_DEMO=1): the notice, the body, write and record limits, and
//! the reset, as the Flask example's tests/test_hosted.py checks them. No browser: HTTP to the
//! app, with a clock the test moves.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum_garden::{Hosted, Store, NOTICE};

const DAY: f64 = 24.0 * 60.0 * 60.0;
const NOON: f64 = 1767268800.0; // 2026-01-01 12:00 UTC

struct Garden {
    base: String,
    store: Arc<Mutex<Store>>,
    time: Arc<Mutex<f64>>,
}

impl Garden {
    async fn new(settings: impl FnOnce(&mut Hosted)) -> Garden {
        let time = Arc::new(Mutex::new(NOON));
        let clock = time.clone();
        let mut hosted = Hosted {
            clock: Arc::new(move || *clock.lock().unwrap()),
            ..Hosted::default()
        };
        settings(&mut hosted);
        let store = Arc::new(Mutex::new(Store::default()));
        let app = axum_garden::app_with(store.clone(), Some(hosted));
        let base = serve(app).await;
        Garden { base, store, time }
    }

    fn pass(&self, seconds: f64) {
        *self.time.lock().unwrap() += seconds;
    }

    fn status(&self, id: &str) -> String {
        self.store.lock().unwrap().plot(id).unwrap()["status"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn records(&self) -> usize {
        self.store.lock().unwrap().records()
    }
}

async fn serve(app: axum::Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address: SocketAddr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap()
    });
    format!("http://{address}")
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .max_redirects(0)
        .build()
        .into()
}

fn get(url: &str) -> (u16, String) {
    let mut response = agent().get(url).call().unwrap();
    (
        response.status().as_u16(),
        response.body_mut().read_to_string().unwrap(),
    )
}

/// The status, the headers that matter here, and the body.
fn post(
    url: &str,
    form: &[(&str, &str)],
    forwarded: Option<&str>,
) -> (u16, HashMap<String, String>, String) {
    let mut request = agent().post(url);
    if let Some(forwarded) = forwarded {
        request = request.header("X-Forwarded-For", forwarded);
    }
    let mut response = request.send_form(form.iter().copied()).unwrap();
    let headers = ["retry-after", "content-type"]
        .into_iter()
        .filter_map(|name| {
            response
                .headers()
                .get(name)
                .map(|value| (name.to_owned(), value.to_str().unwrap().to_owned()))
        })
        .collect();
    let body = response.body_mut().read_to_string().unwrap_or_default();
    (response.status().as_u16(), headers, body)
}

fn sign_up(name: &str) -> Vec<(&str, &str)> {
    vec![
        ("name", name),
        ("email", "kim@example.org"),
        ("crops", "kale"),
        ("household", "1"),
    ]
}

const HARVEST: [(&str, &str); 3] = [("plot", "A1"), ("crop", "kale"), ("kg", "1")];

#[test]
fn from_env() {
    let env = |pairs: &'static [(&'static str, &'static str)]| {
        move |name: &str| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.to_string())
        }
    };
    assert!(Hosted::from_env(env(&[])).is_none());
    assert!(Hosted::from_env(env(&[("HOSTED_DEMO", "0")])).is_none());
    let hosted = Hosted::from_env(env(&[("HOSTED_DEMO", "1"), ("TRUST_PROXIES", "1")])).unwrap();
    assert_eq!((hosted.reset_minutes, hosted.trust_proxies), (1440.0, 1));
    assert_eq!(
        (
            hosted.writes_per_minute,
            hosted.max_records,
            hosted.max_bytes
        ),
        (30, 500, 16 * 1024)
    );
    let hosted =
        Hosted::from_env(env(&[("HOSTED_DEMO", "1"), ("DEMO_RESET_MINUTES", "5")])).unwrap();
    assert_eq!((hosted.reset_minutes, hosted.trust_proxies), (5.0, 0));
}

#[tokio::test(flavor = "multi_thread")]
async fn every_page_says_the_data_resets_and_only_when_hosted() {
    let garden = Garden::new(|_| {}).await;
    let plain = serve(axum_garden::app()).await;
    tokio::task::spawn_blocking(move || {
        for path in ["/", "/plots/A2", "/harvest"] {
            let (_, page) = get(&format!("{}{path}", garden.base));
            // At the top of the body, as in the Flask example's layout.
            assert!(
                page.contains(&format!(
                    "<body>\n  <p class=\"demo-notice\">{NOTICE}</p>\n  <header class=\"top\">"
                )),
                "{path}: {page}"
            );
        }
        assert!(!get(&format!("{plain}/")).1.contains(NOTICE));
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_large_body_is_refused() {
    let garden = Garden::new(|_| {}).await;
    tokio::task::spawn_blocking(move || {
        let name = "x".repeat(20_000);
        let (status, _, _) = post(&format!("{}/plots/A2", garden.base), &sign_up(&name), None);
        assert_eq!(status, 413);
        assert_eq!(garden.status("A2"), "open");
        // Just under the limit is still read.
        let name = "x".repeat(16 * 1024 - 100);
        let (status, _, _) = post(&format!("{}/plots/A2", garden.base), &sign_up(&name), None);
        assert_eq!(status, 303);
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn thirty_writes_a_minute_per_visitor_behind_the_proxy() {
    let garden = Garden::new(|hosted| hosted.trust_proxies = 1).await;
    tokio::task::spawn_blocking(move || {
        let harvest = |who: &str| post(&format!("{}/harvest", garden.base), &HARVEST, Some(who));
        for _ in 0..30 {
            assert_eq!(harvest("203.0.113.1").0, 303);
        }
        let (status, headers, body) = harvest("203.0.113.1");
        assert_eq!(status, 429);
        assert_eq!(headers["retry-after"], "60");
        assert_eq!(body, "Too many changes from here: try again in a minute.");
        // The header a visitor sends comes before the proxy's entry, so it doesn't make them someone else.
        assert_eq!(harvest("198.51.100.7, 203.0.113.1").0, 429);
        assert_eq!(harvest("203.0.113.2").0, 303);
        // Reading is never limited.
        assert_eq!(get(&format!("{}/harvest", garden.base)).0, 200);
        garden.pass(60.0);
        assert_eq!(harvest("203.0.113.1").0, 303);
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn without_a_proxy_the_header_is_the_visitors_own_and_ignored() {
    let garden = Garden::new(|hosted| hosted.writes_per_minute = 2).await;
    tokio::task::spawn_blocking(move || {
        let url = format!("{}/harvest", garden.base);
        assert_eq!(post(&url, &HARVEST, Some("192.0.2.1")).0, 303);
        assert_eq!(post(&url, &HARVEST, Some("192.0.2.2")).0, 303);
        assert_eq!(post(&url, &HARVEST, Some("192.0.2.3")).0, 429);
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn records_stop_at_the_cap() {
    let garden = Garden::new(|hosted| {
        hosted.max_records = 10;
        hosted.writes_per_minute = 100;
    })
    .await;
    tokio::task::spawn_blocking(move || {
        let start = garden.records(); // the seed: one on the waitlist, six harvests
        assert_eq!(start, 7);
        let plot = format!("{}/plots/A1", garden.base);
        for _ in 0..10 - start {
            assert_eq!(post(&plot, &sign_up("Kim"), None).0, 303);
        }
        let (status, _, body) = post(&plot, &sign_up("Kim"), None);
        assert_eq!(status, 507);
        assert_eq!(body, "The demo holds no more until it resets (daily).");
        assert_eq!(
            post(&format!("{}/harvest", garden.base), &HARVEST, None).0,
            507
        );
        assert_eq!(garden.records(), 10);
        assert_eq!(
            get(&format!("{}/", garden.base)).0,
            200,
            "reading still works"
        );
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_data_goes_back_to_its_seed_at_midnight_utc() {
    let garden = Garden::new(|_| {}).await;
    tokio::task::spawn_blocking(move || {
        post(&format!("{}/plots/A2", garden.base), &sign_up("Kim"), None);
        assert_eq!(garden.status("A2"), "taken");
        garden.pass(DAY / 4.0);
        get(&format!("{}/", garden.base));
        assert_eq!(garden.status("A2"), "taken", "not before");
        garden.pass(DAY / 2.0);
        get(&format!("{}/", garden.base));
        assert_eq!(garden.status("A2"), "open");
    })
    .await
    .unwrap();
}
