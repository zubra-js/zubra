# The trip budget (examples/meta/react-router-trips, React Router 8) as a hosted demo, built from the
# repository root:
#   docker build -f deploy/react-router-trips/Dockerfile .
# HOSTED_DEMO=1 caps bodies, writes and expenses and resets them daily (app/lib/hosted.server.js).

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

# 2. The repository's packages the example installs (.npmrc: install-links copies them in).
FROM node:24-bookworm-slim AS packages
WORKDIR /repo
COPY compiler compiler
COPY --from=wasm /repo/target/wasm32-unknown-unknown/release/zubra_wasm.wasm compiler/zubra.wasm
COPY runtime runtime
COPY server server
COPY plugin plugin
COPY examples/meta/react-router-trips examples/meta/react-router-trips
WORKDIR /repo/examples/meta/react-router-trips
# Whatever a local checkout built doesn't come along.
RUN rm -rf build .react-router node_modules

# 3. The build (react-router build: Vite and the zubra plugin), with the dev dependencies.
FROM packages AS build
RUN npm ci --no-audit --no-fund && npm run build

# 4. What `node server.js` needs at run time: no dev dependencies.
FROM packages AS install
RUN npm ci --omit=dev --no-audit --no-fund

# 5. Node.js, the production install, the build, the server and the components @zubra/server
# renders, nothing else.
FROM node:24-bookworm-slim
ENV NODE_ENV=production HOSTED_DEMO=1 TRUST_PROXIES=1
WORKDIR /app
COPY --from=install /repo/examples/meta/react-router-trips/package.json ./
COPY --from=install /repo/examples/meta/react-router-trips/node_modules node_modules
COPY --from=build /repo/examples/meta/react-router-trips/build build
COPY --from=packages /repo/examples/meta/react-router-trips/server.js ./
COPY --from=packages /repo/examples/meta/react-router-trips/app/lib/hosted.server.js app/lib/
COPY --from=packages /repo/examples/meta/react-router-trips/zubra zubra
USER node
CMD ["node", "server.js"]
