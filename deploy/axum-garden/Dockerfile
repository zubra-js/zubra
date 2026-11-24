# The garden from Axum (examples/backends/axum-garden) as a hosted demo, built from the repository
# root:
#   docker build -f deploy/axum-garden/Dockerfile .
# One Rust binary with the components compiled into it (include_zb!): no Node.js, no compiler at
# run time. HOSTED_DEMO=1 caps writes and records, and resets the data daily (src/hosted.rs); the
# data is in memory.

# 1. The binary. The example is its own workspace with its own Cargo.lock; it depends on the zubra
# crate and zubra-macros by path, and includes the Flask example's components and stylesheet.
FROM rust:1.97-slim-bookworm AS build
WORKDIR /repo
COPY Cargo.toml ./
COPY src src
COPY macros macros
COPY examples/backends/flask-garden/components examples/backends/flask-garden/components
COPY examples/backends/flask-garden/static examples/backends/flask-garden/static
COPY examples/backends/axum-garden/Cargo.toml examples/backends/axum-garden/Cargo.lock examples/backends/axum-garden/
COPY examples/backends/axum-garden/src examples/backends/axum-garden/src
WORKDIR /repo/examples/backends/axum-garden
RUN cargo build --locked --release --bin axum-garden

# 2. The binary and the runtime's ES modules (served as they are), nothing else.
FROM debian:bookworm-slim
COPY --from=build /repo/examples/backends/axum-garden/target/release/axum-garden /usr/local/bin/axum-garden
COPY runtime/src /app/runtime
ENV ZUBRA_RUNTIME=/app/runtime PORT=8080 HOSTED_DEMO=1 TRUST_PROXIES=1
USER nobody
# Railway sets PORT; the binary takes ADDRESS.
CMD ["sh", "-c", "ADDRESS=0.0.0.0:$PORT exec axum-garden"]
