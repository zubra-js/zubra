use std::net::SocketAddr;

#[tokio::main]
async fn main() {
    let address = std::env::var("ADDRESS").unwrap_or_else(|_| "127.0.0.1:3000".into());
    // HOSTED_DEMO=1: a public demo, capped and reset daily (src/hosted.rs).
    let hosted = axum_garden::Hosted::from_env(|name| std::env::var(name).ok());
    let listener = tokio::net::TcpListener::bind(&address).await.expect("bind");
    println!("Garden plots on http://{address}");
    let app = axum_garden::app_with(Default::default(), hosted);
    // The socket's address is the visitor's when no proxy in front says otherwise.
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .expect("serve");
}
