# The potluck (examples/meta/solidstart-potluck) as a hosted demo, built from the repository root:
#   docker build -f deploy/solidstart-potluck/Dockerfile .
# HOSTED_DEMO=1 caps sign-ups and writes and resets them daily (src/lib/hosted.js).

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

# 2. The SolidStart build: the repository's packages copied in (.npmrc: install-links), with the dev
# dependencies the build needs (the compiler and the Vite plugin), and no browser for Playwright.
FROM node:24-bookworm-slim AS build
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /repo
COPY compiler compiler
COPY --from=wasm /repo/target/wasm32-unknown-unknown/release/zubra_wasm.wasm compiler/zubra.wasm
COPY registry registry
COPY runtime runtime
COPY server server
COPY plugin plugin
COPY examples/meta/solidstart-potluck examples/meta/solidstart-potluck
WORKDIR /repo/examples/meta/solidstart-potluck
RUN npm ci --no-audit --no-fund
RUN rm -rf .output && npm run build && rm -f zubra/*.d.zb.ts

# 3. Node.js and what `npm start` runs: Nitro's bundle (.output), and what @zubra/server reads at
# run time beside it: the components (zubra/), the compiler's WebAssembly build and the runtime's
# files, which it serves.
FROM node:24-bookworm-slim
ENV NODE_ENV=production HOSTED_DEMO=1 TRUST_PROXIES=1
WORKDIR /app
COPY --from=build /repo/examples/meta/solidstart-potluck/.output .output
COPY --from=build /repo/examples/meta/solidstart-potluck/zubra zubra
COPY --from=build /repo/examples/meta/solidstart-potluck/node_modules/@zubra/compiler node_modules/@zubra/compiler
COPY --from=build /repo/examples/meta/solidstart-potluck/node_modules/@zubra/runtime node_modules/@zubra/runtime
USER node
CMD ["node", ".output/server/index.mjs"]
