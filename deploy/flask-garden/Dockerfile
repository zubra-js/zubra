# The garden (examples/backends/flask-garden) as a hosted demo, built from the repository root:
#   docker build -f deploy/flask-garden/Dockerfile .
# Python and the native zubra CLI, no Node.js. HOSTED_DEMO=1 caps writes and records, and resets
# the data daily (garden/hosted.py); the data is in memory.

# 1. The native compiler, which the zubra package runs as `zubra serve`.
FROM rust:1.97-slim-bookworm AS compiler
WORKDIR /repo
COPY Cargo.toml Cargo.lock ./
COPY src src
COPY wasm wasm
COPY macros macros
COPY sync-server sync-server
RUN cargo build --locked --release --bin zubra

# 2. Flask, a production server and the zubra package from this checkout, in a virtualenv.
FROM python:3.12-slim-bookworm AS install
COPY clients/python /src/clients/python
RUN python -m venv /venv \
 && /venv/bin/pip install --no-cache-dir "flask>=3.1,<4" "gunicorn==23.0.0" /src/clients/python

# 3. Python, the compiler, the example and the runtime's ES modules (served as they are). The
# example keeps its place in the repository's layout: it finds runtime/src from there.
FROM python:3.12-slim-bookworm
COPY --from=compiler /repo/target/release/zubra /usr/local/bin/zubra
COPY --from=install /venv /venv
COPY runtime/src /repo/runtime/src
COPY examples/backends/flask-garden /repo/examples/backends/flask-garden
WORKDIR /repo/examples/backends/flask-garden
ENV PATH=/venv/bin:$PATH PYTHONUNBUFFERED=1 PORT=8080 \
    ZUBRA_COMPILER=/usr/local/bin/zubra ZUBRA_RUNTIME=/repo/runtime/src \
    HOSTED_DEMO=1 TRUST_PROXIES=1
USER nobody
# One process (it keeps the data and one `zubra serve`), a few threads for requests.
CMD exec gunicorn --workers 1 --threads 4 --bind 0.0.0.0:$PORT app:app
