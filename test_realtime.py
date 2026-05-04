"""
Real-time feasibility test for KMB data collection.

Tests:
  1. How long a full cycle takes with N stops per route
  2. How many 403s we get at different concurrency levels
  3. Timestamp spread across routes in one cycle

Requirements: pip install aiohttp
"""

import asyncio
import aiohttp
import time
import random
from datetime import datetime, timezone, timedelta

HKT = timezone(timedelta(hours=8))
KMB_BASE = "https://data.etabus.gov.hk/v1/transport/kmb"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; HKTransitTest/1.0)",
    "Accept": "application/json",
}

stats = {"ok": 0, "timeout": 0, "rate_limited": 0, "other_err": 0}


async def get(session, url, timeout=10):
    try:
        async with session.get(url, headers=HEADERS, timeout=aiohttp.ClientTimeout(total=timeout)) as r:
            if r.status == 403:
                stats["rate_limited"] += 1
                return {}
            r.raise_for_status()
            stats["ok"] += 1
            return await r.json()
    except asyncio.TimeoutError:
        stats["timeout"] += 1
        return {}
    except Exception:
        stats["other_err"] += 1
        return {}


async def fetch_route(session, route, max_stops, semaphore, timestamps):
    async with semaphore:
        for direction in ["outbound", "inbound"]:
            data = await get(session, f"{KMB_BASE}/route-stop/{route}/{direction}/1")
            stops = (data.get("data") or [])[:max_stops]
            if not stops:
                continue
            for stop in stops:
                eta_data = await get(session, f"{KMB_BASE}/eta/{stop['stop']}/{route}/1")
                etas = (eta_data.get("data") or [])[:1]
                if etas:
                    timestamps.append(datetime.now(HKT))
                await asyncio.sleep(0.1)  # 100ms between stops


async def load_routes(session):
    print("Loading KMB routes...")
    data = await get(session, f"{KMB_BASE}/route", timeout=30)
    routes = list({r["route"] for r in (data.get("data") or [])})
    print(f"  Loaded {len(routes)} routes\n")
    return routes


async def run_test(concurrency, max_stops, routes, label):
    global stats
    stats = {"ok": 0, "timeout": 0, "rate_limited": 0, "other_err": 0}
    timestamps = []

    semaphore = asyncio.Semaphore(concurrency)
    start = time.time()

    async with aiohttp.ClientSession() as session:
        tasks = [fetch_route(session, r, max_stops, semaphore, timestamps) for r in routes]
        await asyncio.gather(*tasks)

    elapsed = time.time() - start
    spread = (max(timestamps) - min(timestamps)).total_seconds() / 60 if len(timestamps) > 1 else 0

    print(f"{'─'*55}")
    print(f"  {label}")
    print(f"  Concurrency={concurrency}  MaxStops={max_stops}  Routes={len(routes)}")
    print(f"  Time:         {elapsed/60:.1f} min ({elapsed:.0f}s)")
    print(f"  Timestamp spread: {spread:.1f} min")
    print(f"  Requests:     ok={stats['ok']}  timeout={stats['timeout']}  403={stats['rate_limited']}  err={stats['other_err']}")
    print(f"  ETA snapshots captured: {len(timestamps)}")
    print()
    return elapsed, spread


async def main():
    print("=" * 55)
    print("  KMB Real-time Feasibility Test")
    print(f"  {datetime.now(HKT).strftime('%Y-%m-%d %H:%M:%S HKT')}")
    print("=" * 55 + "\n")

    async with aiohttp.ClientSession() as session:
        routes = await load_routes(session)

    # Shuffle to avoid fixed route→timeslot bias
    random.shuffle(routes)

    # Test 1: current setup (concurrency=1, 15 stops) — just 20 routes to estimate
    sample = routes[:20]
    print("[ TEST 1 ] Current setup estimate (sample of 20 routes)")
    t, _ = await run_test(concurrency=1, max_stops=15, routes=sample, label="concurrency=1, 15 stops (20-route sample)")
    estimated = t / 20 * len(routes)
    print(f"  → Estimated full cycle: {estimated/3600:.1f} hours\n")

    # Test 2: 3 stops, concurrency=1
    print("[ TEST 2 ] 3 stops, concurrency=1 (sample of 20 routes)")
    t, _ = await run_test(concurrency=1, max_stops=3, routes=sample, label="concurrency=1, 3 stops (20-route sample)")
    estimated = t / 20 * len(routes)
    print(f"  → Estimated full cycle: {estimated/60:.1f} min\n")

    # Test 3: 3 stops, concurrency=3 — check for 403s
    print("[ TEST 3 ] 3 stops, concurrency=3 (all routes)")
    await run_test(concurrency=3, max_stops=3, routes=routes, label="concurrency=3, 3 stops (full)")

    # Test 4: 3 stops, concurrency=5
    print("[ TEST 4 ] 3 stops, concurrency=5 (all routes)")
    await run_test(concurrency=5, max_stops=3, routes=routes, label="concurrency=5, 3 stops (full)")


if __name__ == "__main__":
    asyncio.run(main())
