# The conference schedule (examples/meta/next-conference) as a hosted demo, built from the
# repository root:
#   docker build -f deploy/next-conference/Dockerfile .
# HOSTED_DEMO=1 caps the feedback form's writes and resets the ratings daily (lib/hosted.js).

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

# 2. Next's build: the example's whole install (.npmrc: install-links, the repository's packages
# copied in), as the loader is a dev dependency. HOSTED_DEMO is read when Next builds as well as
# when it runs (next.config.mjs), and NEXT_OUTPUT=standalone traces what the server needs.
FROM node:24-bookworm-slim AS build
WORKDIR /repo
COPY compiler compiler
COPY --from=wasm /repo/target/wasm32-unknown-unknown/release/zubra_wasm.wasm compiler/zubra.wasm
COPY registry registry
COPY runtime runtime
COPY plugin plugin
COPY examples/meta/next-conference examples/meta/next-conference
WORKDIR /repo/examples/meta/next-conference
RUN rm -rf .next .next-hosted && npm ci --no-audit --no-fund
ENV NODE_ENV=production HOSTED_DEMO=1 TRUST_PROXIES=1 NEXT_OUTPUT=standalone NEXT_TELEMETRY_DISABLED=1
RUN npx next build && cp -r .next/static .next/standalone/.next/static

# 3. Node.js and Next's standalone server, nothing else.
FROM node:24-bookworm-slim
ENV NODE_ENV=production HOSTED_DEMO=1 TRUST_PROXIES=1 NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /repo/examples/meta/next-conference/.next/standalone .
USER node
CMD ["node", "server.js"]
