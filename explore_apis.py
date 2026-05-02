"""
HK Transit API Explorer
Run: python explore_apis.py
Requires: pip install requests
"""

import requests
import json
from datetime import datetime

KMB_BASE  = "https://data.etabus.gov.hk/v1/transport/kmb"
CTB_BASE  = "https://rt.data.gov.hk/v2/transport/citybus"
GMB_BASE  = "https://data.etagmb.gov.hk"
MTR_BASE  = "https://rt.data.gov.hk/v1/transport/mtr"

DIVIDER = "=" * 60

def get(url, params=None, timeout=10):
    try:
        r = requests.get(url, params=params, timeout=timeout)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        return {"error": str(e)}

def show(label, data, indent=2):
    print(f"\n  [{label}]")
    print(json.dumps(data, indent=indent, ensure_ascii=False, default=str))


# ── KMB ──────────────────────────────────────────────────────────

def explore_kmb():
    print(f"\n{DIVIDER}")
    print("KMB (Kowloon Motor Bus)")
    print(DIVIDER)

    # Total routes
    routes = get(f"{KMB_BASE}/route")
    if "data" in routes:
        all_routes = routes["data"]
        unique = list({r["route"] for r in all_routes})
        print(f"\n  Total route entries : {len(all_routes)}")
        print(f"  Unique route numbers: {len(unique)}")
        print(f"  Sample routes       : {unique[:10]}")

        # Show one route object in full
        show("Sample route object", all_routes[0])
    else:
        show("Error", routes)
        return

    # Stops for one route
    TEST_ROUTE = "1"
    stops = get(f"{KMB_BASE}/route-stop/{TEST_ROUTE}/outbound/1")
    if "data" in stops and stops["data"]:
        print(f"\n  Route {TEST_ROUTE} outbound: {len(stops['data'])} stops")
        show("Sample stop entry", stops["data"][0])

        # Stop detail for first stop
        first_stop_id = stops["data"][0]["stop"]
        stop_detail = get(f"{KMB_BASE}/stop/{first_stop_id}")
        if "data" in stop_detail:
            show("Stop detail (name + coords)", stop_detail["data"])

        # ETA for first stop
        eta = get(f"{KMB_BASE}/eta/{first_stop_id}/{TEST_ROUTE}/1")
        if "data" in eta:
            print(f"\n  ETA entries returned: {len(eta['data'])}")
            if eta["data"]:
                show("Sample ETA entry (all fields)", eta["data"][0])
                print(f"\n  KEY FIELDS:")
                e = eta["data"][0]
                print(f"    co           : {e.get('co')}")
                print(f"    route        : {e.get('route')}")
                print(f"    dir          : {e.get('dir')}")
                print(f"    stop         : {e.get('stop')}")
                print(f"    eta_seq      : {e.get('eta_seq')}  ← 1=next, 2=2nd, 3=3rd bus")
                print(f"    eta          : {e.get('eta')}  ← ISO8601 arrival time")
                print(f"    rmk_en       : '{e.get('rmk_en')}'  ← delay/remark text")
                print(f"    data_timestamp: {e.get('data_timestamp')}")

                # Calculate wait time
                if e.get("eta"):
                    wait = (datetime.fromisoformat(e["eta"].replace("Z","")).replace(tzinfo=None)
                            - datetime.utcnow()).total_seconds()
                    print(f"    → Wait time  : {max(0, round(wait/60, 1))} minutes from now")


# ── CTB ──────────────────────────────────────────────────────────

def explore_ctb():
    print(f"\n{DIVIDER}")
    print("CTB (Citybus)")
    print(DIVIDER)

    routes = get(f"{CTB_BASE}/route/CTB")
    if "data" in routes:
        all_routes = routes["data"]
        print(f"\n  Total CTB routes: {len(all_routes)}")
        show("Sample route object", all_routes[0])

        TEST_ROUTE = all_routes[0]["route"]
        stops = get(f"{CTB_BASE}/route-stop/CTB/{TEST_ROUTE}/outbound")
        if "data" in stops and stops["data"]:
            print(f"\n  Route {TEST_ROUTE} outbound: {len(stops['data'])} stops")
            show("Sample stop entry", stops["data"][0])

            first_stop_id = stops["data"][0]["stop"]

            # Stop detail
            sd = get(f"{CTB_BASE}/stop/{first_stop_id}")
            if "data" in sd:
                show("Stop detail", sd["data"])

            # ETA
            eta = get(f"{CTB_BASE}/eta/CTB/{first_stop_id}/{TEST_ROUTE}")
            if "data" in eta:
                print(f"\n  ETA entries: {len(eta['data'])}")
                if eta["data"]:
                    show("Sample ETA entry", eta["data"][0])
                    e = eta["data"][0]
                    print(f"\n  KEY FIELDS:")
                    print(f"    co      : {e.get('co')}")
                    print(f"    route   : {e.get('route')}")
                    print(f"    dir     : {e.get('dir')}  ← 'O' or 'I'")
                    print(f"    eta     : {e.get('eta')}")
                    print(f"    rmk_en  : '{e.get('rmk_en')}'")
    else:
        show("Error", routes)


# ── GMB ──────────────────────────────────────────────────────────

def explore_gmb():
    print(f"\n{DIVIDER}")
    print("GMB (Green Minibus)")
    print(DIVIDER)

    for region in ["HKI", "KLN", "NT"]:
        routes = get(f"{GMB_BASE}/route/{region}")
        if "data" in routes and routes["data"]:
            data = routes["data"]
            # Count unique route codes
            if isinstance(data, list):
                print(f"\n  Region {region}: {len(data)} route entries")
                show(f"First route object ({region})", data[0])
            else:
                show(f"Region {region} response structure", data)
        else:
            print(f"\n  Region {region}: {routes}")

    # Deep-dive one GMB route (step-by-step chain)
    print(f"\n  ── GMB Multi-Step Data Chain ──")

    # Step 1: Resolve route_id and route_seq
    TEST_REGION = "HKI"
    TEST_CODE   = "1"
    r1 = get(f"{GMB_BASE}/route/{TEST_REGION}/{TEST_CODE}")
    print(f"\n  Step 1 GET /route/{TEST_REGION}/{TEST_CODE}")
    if "data" in r1 and r1["data"]:
        show("Route resolution response", r1["data"])
        # Extract route_id and route_seq
        route_data = r1["data"]
        if isinstance(route_data, list):
            route_data = route_data[0]
        routes_list = route_data.get("directions") or route_data.get("route_seq") or []
        route_id  = route_data.get("route_id")
        route_seq = 1
        if isinstance(route_data, dict):
            # Try to find route_id at top level or nested
            for key in route_data:
                if "route_id" in str(key).lower():
                    route_id = route_data[key]
        print(f"    Extracted route_id: {route_id}")
    else:
        print(f"    Response: {r1}")
        # Try different route
        r1 = get(f"{GMB_BASE}/route/KLN/1")
        show("KLN route 1 response", r1)
        return

    if route_id:
        # Step 2: Fetch stops
        print(f"\n  Step 2 GET /route-stop/{route_id}/1")
        r2 = get(f"{GMB_BASE}/route-stop/{route_id}/1")
        if "data" in r2 and r2["data"]:
            show("Route-stop response", r2["data"])
            stops = r2["data"].get("route_stops") or r2["data"]
            if isinstance(stops, list) and stops:
                first_stop = stops[0]
                stop_seq = first_stop.get("stop_seq") or 1
                print(f"    First stop: {first_stop}")

                # Step 3: ETA for first stop
                print(f"\n  Step 3 GET /eta/route-stop/{route_id}/1/{stop_seq}")
                r3 = get(f"{GMB_BASE}/eta/route-stop/{route_id}/1/{stop_seq}")
                show("ETA response", r3)
                if "data" in r3 and r3["data"]:
                    eta_list = r3["data"].get("etas") or r3["data"]
                    if isinstance(eta_list, list) and eta_list:
                        e = eta_list[0]
                        print(f"\n  KEY FIELDS:")
                        print(f"    diff       : {e.get('diff')}  ← minutes until arrival")
                        print(f"    remarks_en : '{e.get('remarks_en')}'")
                        print(f"    timestamp  : {e.get('timestamp')}")


# ── MTR ──────────────────────────────────────────────────────────

def explore_mtr():
    print(f"\n{DIVIDER}")
    print("MTR (Mass Transit Railway)")
    print(DIVIDER)

    test_cases = [
        ("AEL", "HOK"),
        ("TWL", "TST"),
        ("KTL", "KWT"),
        ("ISL", "CEN"),
    ]

    for line, station in test_cases:
        r = get(f"{MTR_BASE}/getSchedule.php", params={"line": line, "sta": station})
        print(f"\n  Line={line}, Station={station}")
        if "data" in r and r["data"]:
            station_data = r["data"].get(f"{line}-{station}") or r["data"]
            show("Schedule response", station_data)

            # Show key fields from first UP train
            if isinstance(station_data, dict):
                up = station_data.get("UP", [])
                dn = station_data.get("DOWN", [])
                print(f"    UP trains  : {len(up)}")
                print(f"    DOWN trains: {len(dn)}")
                if up:
                    t = up[0]
                    print(f"\n  KEY FIELDS (UP[0]):")
                    print(f"    time     : {t.get('time')}  ← 'YYYY-MM-DD HH:MM:SS'")
                    print(f"    dest     : {t.get('dest')}  ← destination station code")
                    print(f"    plat     : {t.get('plat')}  ← platform number")
                    print(f"    is_delay : {t.get('is_delay')}  ← 'Y' or 'N'")
                break
        else:
            print(f"    Response: {r}")

    # Check if MTR returns sys_time for freshness check
    r = get(f"{MTR_BASE}/getSchedule.php", params={"line": "TWL", "sta": "TST"})
    sys_time = r.get("sys_time") or r.get("curr_time")
    status   = r.get("status")
    print(f"\n  MTR response meta:")
    print(f"    status   : {status}  ← 1=ok, 0=error")
    print(f"    sys_time : {sys_time}  ← server timestamp")
    print(f"    message  : {r.get('message')}")


# ── SUMMARY ──────────────────────────────────────────────────────

def summary():
    print(f"\n{DIVIDER}")
    print("SUMMARY: What data can we collect?")
    print(DIVIDER)
    print("""
  KMB
  ├─ Fields: route, dir, stop_id, eta (ISO8601), eta_seq (1/2/3), rmk_en
  ├─ Up to 3 upcoming buses per stop
  ├─ All routes loadable dynamically from /route
  └─ Wait time = (eta - now) in seconds

  CTB (Citybus)
  ├─ Fields: co, route, dir, stop_id, eta (ISO8601), rmk_en
  ├─ Same ETA structure as KMB
  └─ Direction uses 'O'/'I' string

  GMB (Green Minibus)
  ├─ Fields: diff (minutes), remarks_en
  ├─ 3-step chain: region→route_id→stop_seq→eta
  ├─ No ISO timestamp, just 'diff' minutes offset
  └─ 3 regions: HKI / KLN / NT

  MTR
  ├─ Fields: time (YYYY-MM-DD HH:MM:SS), dest, plat, is_delay (Y/N)
  ├─ UP / DOWN directions per station
  ├─ is_delay flag is directly usable — no calculation needed
  └─ Static line+station mapping required (no discovery API)

  WHAT WE CAN ANALYSE:
  ├─ Wait time distribution per route/stop/hour/day
  ├─ Delay frequency (rmk_en contains 'delay' / is_delay='Y')
  ├─ Peak vs off-peak patterns (7-9am, 5-8pm)
  ├─ Cross-operator reliability comparison
  ├─ Route headway (time between consecutive buses)
  └─ 2-week trend: does service degrade on certain days?
    """)


if __name__ == "__main__":
    explore_kmb()
    explore_ctb()
    explore_gmb()
    explore_mtr()
    summary()
