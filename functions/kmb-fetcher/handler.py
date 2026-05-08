import json
import os
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests
import redis as redislib
from flask import Flask, jsonify

app = Flask(__name__)

KMB_BASE      = "https://data.etabus.gov.hk/v1/transport/kmb"
REDIS_URL     = os.environ.get("REDIS_URL",  "redis://redis.hk-bus.svc.cluster.local:6379")
STREAM_KEY    = os.environ.get("STREAM_KEY", "kmb-eta-raw")
STREAM_MAXLEN = 50000
CONCURRENCY   = int(os.environ.get("CONCURRENCY", "8"))

_routes_cache: list[str] = []

def load_routes() -> list[str]:
    global _routes_cache
    if _routes_cache:
        return _routes_cache
    try:
        resp = requests.get(f"{KMB_BASE}/route", timeout=15)
        resp.raise_for_status()
        routes = list({r["route"] for r in resp.json().get("data", [])})
        _routes_cache = sorted(routes)
        print(f"[kmb-fetcher] Loaded {len(_routes_cache)} routes from API")
    except Exception as e:
        print(f"[kmb-fetcher] Failed to load routes: {e}, using empty list")
        _routes_cache = []
    return _routes_cache


def fetch_route(route: str, r, fetched_at: str) -> tuple[int, int]:
    """
    Fetch ETAs for all stops on a route in one API call (route-eta endpoint).
    One call replaces ~34 individual stop-eta calls.
    """
    published = 0
    try:
        resp = requests.get(f"{KMB_BASE}/route-eta/{route}/1", timeout=15)
        resp.raise_for_status()
        for rec in resp.json().get("data", []):
            if not rec.get("eta"):
                continue
            r.xadd(STREAM_KEY, {
                "co":         rec.get("co") or "KMB",
                "route":      rec.get("route") or route,
                "dir":        rec.get("dir") or "",
                "seq":        str(rec.get("seq") or ""),
                "stop":       rec.get("stop") or "",
                "eta_seq":    str(rec.get("eta_seq") or ""),
                "eta":        rec.get("eta") or "",
                "rmk_en":     rec.get("rmk_en") or "",
                "fetched_at": fetched_at,
            }, maxlen=STREAM_MAXLEN, approximate=True)
            published += 1
    except Exception as e:
        print(f"[kmb-fetcher] route {route}: {e}")
        return 0, 1
    return published, 0


@app.get("/healthz")
def healthz():
    return jsonify({"status": "ok"})


@app.post("/")
def handle():
    r          = redislib.from_url(REDIS_URL, decode_responses=True)
    fetched_at = datetime.now(timezone.utc).isoformat()
    published  = 0
    errors     = 0

    routes = load_routes()
    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        futures = {pool.submit(fetch_route, route, r, fetched_at): route for route in routes}
        for future in as_completed(futures):
            p, e = future.result()
            published += p
            errors    += e

    return jsonify({"published": published, "routes": len(routes), "errors": errors})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080, threaded=True)
