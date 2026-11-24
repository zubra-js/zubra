# The standup board (examples/standup) as a hosted demo, built from the repository root:
#   docker build -f deploy/standup/Dockerfile .
# HOSTED_DEMO=1 caps its log and resets it daily (examples/standup/hosted.js).

# 1. The compiler as WebAssembly (compiler/zubra.wasm), from this checkout's Rust sources.
FROM rust:1.97-slim-bookworm AS wasm
RUN rustup target add wasm32-unknown-unknown
WORKDIR /repo
COPY Cargo.toml Cargo.lock ./
COPY src src
COPY wasm wasm
COPY macros macros
COPY sync-server sync-server
RUN cargo build --locked -p zubra-wasm --target wasm32-unknown-unknown --release

# 2. The example's install: the repository's packages copied in (.npmrc: install-links), no dev
# dependencies.
FROM node:24-bookworm-slim AS install
WORKDIR /repo
COPY compiler compiler
COPY --from=wasm /repo/target/wasm32-unknown-unknown/release/zubra_wasm.wasm compiler/zubra.wasm
COPY registry registry
COPY runtime runtime
COPY server server
COPY sync sync
COPY examples/standup examples/standup
WORKDIR /repo/examples/standup
RUN npm ci --omit=dev --no-audit --no-fund

# 3. Node.js and the example, nothing else.
FROM node:24-bookworm-slim
ENV NODE_ENV=production HOSTED_DEMO=1 TRUST_PROXIES=1
WORKDIR /app
COPY --from=install /repo/examples/standup .
USER node
CMD ["node", "server.js"]
