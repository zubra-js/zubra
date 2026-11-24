# The Nuxt bookshop (examples/meta/nuxt-bookshop) as a hosted demo, built from the repository root:
#   docker build -f deploy/nuxt-bookshop/Dockerfile .
# HOSTED_DEMO=1 caps writes and resets the books daily (server/hosted.js, server/middleware/hosted.ts).

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

# 2. `nuxt build`, which needs the dev dependencies (the Vite plugin, the compiler): the
# repository's packages copied in (.npmrc: install-links). Nitro writes the server and what it
# imports, the compiler included, to .output.
FROM node:24-bookworm-slim AS build
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /repo
COPY compiler compiler
COPY --from=wasm /repo/target/wasm32-unknown-unknown/release/zubra_wasm.wasm compiler/zubra.wasm
COPY plugin plugin
COPY runtime runtime
COPY server server
COPY examples/meta/nuxt-bookshop examples/meta/nuxt-bookshop
WORKDIR /repo/examples/meta/nuxt-bookshop
RUN rm -rf .nuxt .output && npm ci --no-audit --no-fund && npm run build

# 3. Node.js, .output and the components' sources, which @zubra/server reads from ./zubra when it
# starts (server/plugins/zubra.ts) to give the server HTML their shadow roots. Nitro listens on PORT,
# on every interface.
FROM node:24-bookworm-slim
ENV NODE_ENV=production HOSTED_DEMO=1 TRUST_PROXIES=1
WORKDIR /app
COPY --from=build /repo/examples/meta/nuxt-bookshop/.output .output
COPY --from=build /repo/examples/meta/nuxt-bookshop/zubra/*.zb zubra/
USER node
CMD ["node", ".output/server/index.mjs"]
