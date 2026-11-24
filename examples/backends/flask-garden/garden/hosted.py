"""The garden as a public demo (`HOSTED_DEMO=1`, as in deploy/flask-garden): strangers can write to
it, so it takes small bodies, a few writes a minute from each visitor and a bounded number of
records, and goes back to its seed data every `reset_minutes` (a day by default, at midnight UTC).
"""
from __future__ import annotations

import threading
import time
from typing import Callable, Mapping

from flask import Flask, Response, request
from werkzeug.middleware.proxy_fix import ProxyFix

NOTICE = "Demo: data resets daily."


def from_env(env: Mapping[str, str]) -> dict | None:
    """Settings from the environment, or None when the garden isn't a hosted demo."""
    if env.get("HOSTED_DEMO") != "1":
        return None
    return {"reset_minutes": float(env.get("DEMO_RESET_MINUTES", 1440)), "trust_proxies": int(env.get("TRUST_PROXIES", 0))}


def install(
    app: Flask,
    store,
    *,
    reset_minutes: float = 1440,
    trust_proxies: int = 0,
    writes_per_minute: int = 30,
    max_records: int = 500,
    max_bytes: int = 16 * 1024,
    clock: Callable[[], float] = time.time,
) -> None:
    # A larger body is a 413 before a route reads it.
    app.config["MAX_CONTENT_LENGTH"] = max_bytes
    # The visitor's address is the entry the proxies in front appended to X-Forwarded-For, never one
    # the visitor wrote, so the write limit can't be dodged by sending the header.
    if trust_proxies:
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=trust_proxies)
    period = reset_minutes * 60
    state = {"epoch": int(clock() // period), "minute": -1, "writes": {}}
    lock = threading.Lock()

    @app.before_request
    def guard():
        now = clock()
        with lock:
            if int(now // period) != state["epoch"]:
                state["epoch"] = int(now // period)
                store.reset()
            if request.method != "POST":
                return None
            if int(now // 60) != state["minute"]:
                state["minute"] = int(now // 60)
                state["writes"].clear()
            who = request.remote_addr or "unknown"
            state["writes"][who] = state["writes"].get(who, 0) + 1
            if state["writes"][who] > writes_per_minute:
                return Response("Too many changes from here: try again in a minute.", 429, {"Retry-After": "60"})
        # The plots are a fixed sixteen; the waitlist and the harvests grow, up to this many.
        if store.records() >= max_records:
            return Response("The demo holds no more until it resets (daily).", 507)
        return None

    @app.context_processor
    def notice():
        return {"demo_notice": NOTICE}
