"""The garden as a public demo (HOSTED_DEMO=1): the notice, the body, write and record limits, and
the reset. No browser: Flask's test client, with a clock the test moves.

    python -m unittest discover -s tests -v
"""
from __future__ import annotations

import unittest

from garden import create_app
from garden.hosted import NOTICE, from_env
from garden.store import Store

DAY = 24 * 60 * 60
NOON = 1767268800  # 2026-01-01 12:00 UTC


def sign_up(name: str = "Kim", **extra) -> dict:
    return {"name": name, "email": "kim@example.org", "crops": ["kale"], "household": "1", **extra}


class Hosted(unittest.TestCase):
    def garden(self, **options):
        self.time = NOON
        self.store = Store()
        app = create_app(store=self.store, hosted={"clock": lambda: self.time, **options})
        return app.test_client()

    def test_from_env(self):
        self.assertIsNone(from_env({}))
        self.assertEqual(from_env({"HOSTED_DEMO": "1", "TRUST_PROXIES": "1"}), {"reset_minutes": 1440, "trust_proxies": 1})

    def test_every_page_says_the_data_resets_and_only_when_hosted(self):
        client = self.garden()
        for path in ("/", "/plots/A2", "/harvest"):
            self.assertIn(NOTICE, client.get(path).text, path)
        self.assertNotIn(NOTICE, create_app(store=Store()).test_client().get("/").text)

    def test_a_visitor_cannot_reset_everyone_elses_edits(self):
        # The tests' /reset would let one visitor wipe the others' work: the demo resets on its own.
        client = self.garden()
        self.assertEqual(client.post("/plots/A2", data=sign_up()).status_code, 303)
        self.assertNotEqual(self.store.plot("A2")["status"], "open")
        self.assertEqual(client.post("/reset").status_code, 404)
        self.assertNotEqual(self.store.plot("A2")["status"], "open")

    def test_a_large_body_is_refused(self):
        client = self.garden()
        response = client.post("/plots/A2", data=sign_up("x" * 20_000))
        self.assertEqual(response.status_code, 413)
        self.assertEqual(self.store.plot("A2")["status"], "open")

    def test_thirty_writes_a_minute_per_visitor_behind_the_proxy(self):
        client = self.garden(trust_proxies=1)
        harvest = lambda who: client.post("/harvest", data={"plot": "A1", "crop": "kale", "kg": "1"}, headers={"X-Forwarded-For": who})
        for _ in range(30):
            self.assertEqual(harvest("203.0.113.1").status_code, 303)
        self.assertEqual(harvest("203.0.113.1").status_code, 429)
        # The header a visitor sends comes before the proxy's entry, so it doesn't make them someone else.
        self.assertEqual(harvest("198.51.100.7, 203.0.113.1").status_code, 429)
        self.assertEqual(harvest("203.0.113.2").status_code, 303)
        self.time += 60
        self.assertEqual(harvest("203.0.113.1").status_code, 303)

    def test_records_stop_at_the_cap(self):
        client = self.garden(max_records=10, writes_per_minute=100)
        start = self.store.records()  # the seed: one on the waitlist, six harvests
        for _ in range(10 - start):
            self.assertEqual(client.post("/plots/A1", data=sign_up()).status_code, 303)
        self.assertEqual(client.post("/plots/A1", data=sign_up()).status_code, 507)
        self.assertEqual(client.post("/harvest", data={"plot": "A1", "crop": "kale", "kg": "1"}).status_code, 507)
        self.assertEqual(self.store.records(), 10)
        self.assertEqual(client.get("/").status_code, 200, "reading still works")

    def test_the_data_goes_back_to_its_seed_at_midnight_utc(self):
        client = self.garden()
        client.post("/plots/A2", data=sign_up())
        self.assertEqual(self.store.plot("A2")["status"], "taken")
        self.time += DAY // 4
        client.get("/")
        self.assertEqual(self.store.plot("A2")["status"], "taken", "not before")
        self.time += DAY // 2
        client.get("/")
        self.assertEqual(self.store.plot("A2")["status"], "open")


if __name__ == "__main__":
    unittest.main()
