# Hosted demos

The examples that need a server, hosted on Railway so the [gallery](https://zubra-js.github.io/zubra/) can open them (`live` in `demos/list.js`). One Railway project, `zubra-demos`, with a service per folder here:

| Folder | Example | Image |
|---|---|---|
| `standup/` | `examples/standup` | Node.js, the compiler as WebAssembly |
| `hono-bikes/` | `examples/hypermedia/hono-bikes` | Node.js, the compiler as WebAssembly |
| `flask-garden/` | `examples/backends/flask-garden` | Python and the native `zubra` CLI, no Node.js |

Each folder has:
- a `Dockerfile`, built from the repository root: `docker build -f deploy/<demo>/Dockerfile .`;
- a `railway.json`: Railway's build and deploy settings for the service (the Dockerfile, the paths whose changes rebuild it, sleeping when idle).

Railway doesn't read these `railway.json` files itself: config as code is deprecated. [`.railway/railway.ts`](../.railway/railway.ts) declares a service per folder from them, and is applied by hand:

```sh
cd .railway && npm ci
railway link                 # the zubra-demos project, production
railway config plan          # what would change
railway config apply
```

A push to `main` rebuilds only the services whose watched paths changed.

## Public-demo safety

The images set `HOSTED_DEMO=1` and `TRUST_PROXIES=1` (Railway's proxy appends the visitor's address to `X-Forwarded-For`). Each example's own server then:
- says "Demo: data resets daily." on every page;
- limits request bodies and each visitor's writes;
- bounds what it stores;
- resets its data at midnight UTC and whenever it starts. Its data is in memory, or a SQLite file in `/tmp`, and there are no volumes.

See `hosted.js` / `hosted.py` in each example for the numbers. `DEMO_RESET_MINUTES` shortens the reset period, to watch a reset happen.

Services sleep when idle, so the first request after a while starts the container: a few seconds.

## Adding a demo

1. Give the example a hosted mode (as above), with a test.
2. Add `deploy/<demo>/Dockerfile` and `railway.json` (copy one of these; list the paths that go into the image in `watchPatterns`).
3. `railway config apply`, then `railway domain --service <demo> --port 8080` for its URL.
4. Add `live` to its entry in `demos/list.js`.
