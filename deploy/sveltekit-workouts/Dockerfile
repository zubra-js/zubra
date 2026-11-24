# The workout log (examples/meta/sveltekit-workouts) as a hosted demo, built from the repository root:
#   docker build -f deploy/sveltekit-workouts/Dockerfile .
# HOSTED_DEMO=1 caps writes and the log and resets it daily (src/lib/server/hosted.js).
#
# SvelteKit 3 takes the origin it checks form posts against from `paths.origin` at build time
# (ORIGIN, in vite.config.js): the public URL, since Railway's proxy sends the browser's https
# Origin to the container's plain HTTP. Build with `--build-arg ORIGIN=…` to serve it elsewhere.
ARG ORIGIN=https://sveltekit-workouts-production.up.railway.app

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

# 2. The example's build: all its dependencies (Vite, SvelteKit and the Zubra plugin are dev
# dependencies), the repository's packages copied in (.npmrc: install-links), then `vite build`.
FROM node:24-bookworm-slim AS build
ARG ORIGIN
WORKDIR /repo
COPY compiler compiler
COPY --from=wasm /repo/target/wasm32-unknown-unknown/release/zubra_wasm.wasm compiler/zubra.wasm
COPY registry registry
COPY runtime runtime
COPY server server
COPY plugin plugin
COPY examples/meta/sveltekit-workouts examples/meta/sveltekit-workouts
WORKDIR /repo/examples/meta/sveltekit-workouts
RUN npm ci --no-audit --no-fund
RUN ORIGIN="$ORIGIN" npm run build

# 3. Node.js, the built server and what it loads when it runs: the components (the hook renders
# their shadow roots with @zubra/server, which compiles them with @zubra/compiler) and the three
# Zubra packages, which have no dependencies of their own. Everything else is in build/.
FROM node:24-bookworm-slim
ENV NODE_ENV=production HOSTED_DEMO=1 TRUST_PROXIES=1 BODY_SIZE_LIMIT=16K
WORKDIR /app
COPY --from=build /repo/examples/meta/sveltekit-workouts/package.json ./
COPY --from=build /repo/examples/meta/sveltekit-workouts/build build
COPY --from=build /repo/examples/meta/sveltekit-workouts/zubra zubra
COPY --from=build /repo/examples/meta/sveltekit-workouts/node_modules/@zubra/compiler node_modules/@zubra/compiler
COPY --from=build /repo/examples/meta/sveltekit-workouts/node_modules/@zubra/runtime node_modules/@zubra/runtime
COPY --from=build /repo/examples/meta/sveltekit-workouts/node_modules/@zubra/server node_modules/@zubra/server
USER node
CMD ["node", "build"]
