# The help desk (examples/helpdesk) as a hosted demo, built from the repository root:
#   docker build -f deploy/helpdesk/Dockerfile .
# HOSTED_DEMO=1 keeps its data in memory (never MongoDB), caps writes and records, and resets it
# daily (examples/helpdesk/src/hosted.js).

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
# dependencies, and no MongoDB driver (the hosted demo never opens MongoDB; the rest at the
# lockfile's versions). Then the example's own check that it has a compiler (`prestart`), which
# finds the WebAssembly one.
FROM node:24-bookworm-slim AS install
WORKDIR /repo
COPY compiler compiler
COPY --from=wasm /repo/target/wasm32-unknown-unknown/release/zubra_wasm.wasm compiler/zubra.wasm
COPY registry registry
COPY runtime runtime
COPY server server
COPY actions actions
COPY examples/helpdesk examples/helpdesk
WORKDIR /repo/examples/helpdesk
RUN npm pkg delete dependencies.mongodb \
 && npm install --omit=dev --no-audit --no-fund \
 && node scripts/ensure-compiler.js

# 3. Node.js and the example, nothing else. @zubra/actions writes the components' server halves
# to node_modules/.cache when it starts, so that folder is the app user's.
FROM node:24-bookworm-slim
ENV NODE_ENV=production HOSTED_DEMO=1 TRUST_PROXIES=1
WORKDIR /app
COPY --from=install /repo/examples/helpdesk .
RUN mkdir -p node_modules/.cache && chown node:node node_modules/.cache
USER node
CMD ["npm", "start"]
