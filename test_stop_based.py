"""
Stop-based ETA fetching benchmark.

Instead of: route → stops → ETA per route (many calls)
We use:     stop → /stop-eta/{stop_id} → all routes at once (one call per stop)

Tests:
  1. How many unique stops exist
  2. How long a full cycle takes at different concurrency levels
  3. 403 rate at each concurrency level
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


async def load_all_stops(session):
    """Load all unique KMB stop IDs from the /stop endpoint."""
    print("Loading all KMB stops...")
    data = await get(session, f"{KMB_BASE}/stop", timeout=30)
    stops = [s["stop"] for s in (data.get("data") or [])]
    print(f"  Found {len(stops)} unique stops\n")
    return stops


async def fetch_stop_eta(session, stop_id, semaphore, results):
    """Fetch all ETAs at a stop in one API call."""
    async with semaphore:
        data = await get(session, f"{KMB_BASE}/stop-eta/{stop_id}")
        etas = data.get("data") or []
        if etas:
            results.append({
                "stop_id": stop_id,
                "eta_count": len(etas),
                "routes": list({e["route"] for e in etas}),
                "fetched_at": datetime.now(HKT),
            })
        await asyncio.sleep(0.05)  # gentle 50ms between stops


async def run_test(concurrency, stops, label):
    global stats
    stats = {"ok": 0, "timeout": 0, "rate_limited": 0, "other_err": 0}
    results = []

    semaphore = asyncio.Semaphore(concurrency)
    start = time.time()

    async with aiohttp.ClientSession() as session:
        tasks = [fetch_stop_eta(session, s, semaphore, results) for s in stops]
        await asyncio.gather(*tasks)

    elapsed = time.time() - start
    timestamps = [r["fetched_at"] for r in results]
    spread = (max(timestamps) - min(timestamps)).total_seconds() / 60 if len(timestamps) > 1 else 0
    total_etas = sum(r["eta_count"] for r in results)
    total_requests = stats["ok"] + stats["rate_limited"] + stats["timeout"] + stats["other_err"]
    loss_pct = round(stats["rate_limited"] / total_requests * 100, 1) if total_requests else 0

    print(f"{'─'*55}")
    print(f"  {label}")
    print(f"  Concurrency={concurrency}  Stops={len(stops)}")
    print(f"  Time:             {elapsed/60:.1f} min ({elapsed:.0f}s)")
    print(f"  Timestamp spread: {spread:.1f} min")
    print(f"  Stops with data:  {len(results)} / {len(stops)}")
    print(f"  Total ETA records:{total_etas}")
    print(f"  403 rate:         {stats['rate_limited']}/{total_requests} ({loss_pct}%)")
    print()
    return elapsed, spread


async def main():
    print("=" * 55)
    print("  KMB Stop-Based Fetching Benchmark")
    print(f"  {datetime.now(HKT).strftime('%Y-%m-%d %H:%M:%S HKT')}")
    print("=" * 55 + "\n")

    async with aiohttp.ClientSession() as session:
        all_stops = await load_all_stops(session)

    random.shuffle(all_stops)

    # Fine-grained test: find highest concurrency with 0% 403
    for c in [1, 2, 3, 4, 5]:
        print(f"[ TEST concurrency={c} ] All stops")
        await run_test(concurrency=c, stops=all_stops, label=f"concurrency={c}, all {len(all_stops)} stops")


if __name__ == "__main__":
    asyncio.run(main())
