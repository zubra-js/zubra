# zubra-sync

The log that `'use collection'` devices share, as one binary: the same HTTP protocol as `@zubra/sync/server`, the same SQLite table as `sqliteLog()`, and no Node.js. For servers in Python, Go, PHP or anything else, or a small box of its own.

```sh
cargo build --release -p zubra-sync
./target/release/zubra-sync --db sync.db --port 4000 --open
```

| Option | |
|---|---|
| `--db <file>` | the SQLite log (default `sync.db`); the same file `sqliteLog()` reads and writes |
| `--keep-latest` | keep each field's latest value in the same `latest` table as `sqliteLog(path, { keep: 'latest' })`; default is the full log |
| `--host`, `--port` | where to listen (default `127.0.0.1:4000`; `--port 0` picks a free one and prints it) |
| `--origin <url>` | an origin whose pages may use it directly, with CORS; repeatable |
| `--allowed-host <name>` | a host name it answers to, besides an IP address, `localhost`, `*.localhost`, `--host` and each `--origin`'s host; `.app.example` is that name and every name under it; repeatable. `any` answers to every name |
| `--keep-alive <ms>` | how often a quiet live stream gets a keep-alive comment (default 15000) |
| `--read <collection>` | let pages read this collection (repeatable). Without it, `--read-all` or `--open`, pages read nothing |
| `--read-all` | let pages read every collection, and still write nothing |
| `--open` | take reads and writes (push, presence, signal) from pages. Without it, writes are refused with a 403 |

**It answers only to names it knows.** A request whose `Host` is another name gets a 403, before anything is read or written. That stops DNS rebinding: a page on an attacker's site, whose DNS is then pointed at this machine, would otherwise read and write the log as if it were that site's own server, with the browser's blessing. So behind a proxy that passes the visitor's `Host` through (Caddy does, and so does a Docker service name or `*.railway.internal`), start it with `--allowed-host` for that name. A proxy that sends `Host: 127.0.0.1:4000` (nginx's default) needs nothing.

It has no notion of users or permissions, so pages read nothing until it's told which collections they may (`--read`, `--read-all`), and write nothing until it's started with `--open`; `--open` also opens reads for every collection. It says so at start. Then put it behind your app at `/_zb/sync` (a reverse proxy, after the app's own sign-in), which also makes it same-origin for the pages, or run it on a network you trust. Pages then `connect()` as usual.

On the first start with `--keep-latest`, the latest value of each field in an existing full log is copied after its old cursors, so devices can catch up. The original `changes` table is retained; subsequent writes go to `latest`. Keep using `--keep-latest` on restarts, including when opening the file with `sqliteLog`, or the old full log will be used instead.

Each live connection occupies a thread. Replay is sent a page at a time; if a connection falls more than 16 events behind, it is closed after its queued events and reconnects from its cursor. Changes are recovered from the log, but presence and signaling are transient. Put connection and request limits at the proxy, and load-test expected connections, write rates, slow clients and log size before deployment. Scopes filter after a log page is read, so a narrow scope still pays for unrelated history.

Its tests are `@zubra/sync`'s: `npm test` in `sync/` runs the protocol tests against both servers when the binary is built, and `npm run test:binary` runs the browser tests with the binary behind a proxy.
