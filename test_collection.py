"""
Small-scale data collection test
Tests KMB, CTB, GMB, MTR collection logic and inserts into PostgreSQL.

Requirements: pip install requests psycopg2-binary
PostgreSQL must be running: docker compose up -d postgres
"""

import requests
import psycopg2
import psycopg2.extras
from datetime import datetime, timezone, timedelta
import time

# ── Config ────────────────────────────────────────────────────
DB  = dict(host="localhost", port=5432, dbname="hkbus", user="postgres", password="postgres")
HKT = timezone(timedelta(hours=8))

def to_hkt(dt):
    """Convert any datetime to a naive HKT datetime for storage."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt  # assume already HKT naive
    return dt.astimezone(HKT).replace(tzinfo=None)

KMB_BASE = "https://data.etabus.gov.hk/v1/transport/kmb"
CTB_BASE = "https://rt.data.gov.hk/v2/transport/citybus"
GMB_BASE = "https://data.etagmb.gov.hk"
MTR_BASE = "https://rt.data.gov.hk/v1/transport/mtr"

# Small scale: just enough to verify logic
KMB_TEST_ROUTES = ["1", "2", "5C"]
CTB_TEST_ROUTES = ["1", "5B", "10"]
GMB_TEST        = [("HKI", "1"), ("KLN", "2"), ("NT", "1")]
MTR_TEST        = [("AEL", "HOK"), ("TWL", "TST"), ("KTL", "DIH")]

DIVIDER = "=" * 60

# ── HTTP helper ───────────────────────────────────────────────
def get(url, params=None, timeout=10):
    try:
        r = requests.get(url, params=params, timeout=timeout)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"    ⚠ GET {url} failed: {e}")
        return {}

# ── Shared insert helper ──────────────────────────────────────
def insert_eta(cur, schema, route_or_line, region_or_none, dir,
               stop_id, eta_seq, wait_minutes, eta_timestamp,
               is_scheduled, remarks, extra_cols="", extra_vals=()):
    now    = to_hkt(datetime.now(HKT))
    eta_ts = to_hkt(eta_timestamp)

    if schema == "mtr":
        line, station, dest, platform = (
            extra_vals[0], extra_vals[1], extra_vals[2], extra_vals[3]
        )
        cur.execute("""
            INSERT INTO mtr.eta
                (line, station, dir, eta_seq, dest, platform,
                 wait_minutes, eta_timestamp, fetched_at, hour_of_day, day_of_week)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """, (line, station, dir, eta_seq, dest, platform,
              wait_minutes, eta_ts, now, now.hour, now.weekday()))

    elif schema == "gmb":
        route_id, route_code, route_seq = (
            extra_vals[0], extra_vals[1], extra_vals[2]
        )
        cur.execute("""
            INSERT INTO gmb.eta
                (route_id, route_code, region, route_seq, stop_id, eta_seq,
                 wait_minutes, eta_timestamp, is_scheduled, remarks,
                 fetched_at, hour_of_day, day_of_week)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """, (route_id, route_code, region_or_none, route_seq, stop_id, eta_seq,
              wait_minutes, eta_ts, is_scheduled, remarks,
              now, now.hour, now.weekday()))

    else:
        table = f"{schema}.eta"
        cur.execute(f"""
            INSERT INTO {table}
                (route, dir, stop_id, eta_seq, wait_minutes, eta_timestamp,
                 is_scheduled, remarks, fetched_at, hour_of_day, day_of_week)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """, (route_or_line, dir, stop_id, eta_seq,
              wait_minutes, eta_ts, is_scheduled, remarks,
              now, now.hour, now.weekday()))

# ── KMB ──────────────────────────────────────────────────────
def collect_kmb(conn):
    print(f"\n{DIVIDER}\nKMB — {KMB_TEST_ROUTES}\n{DIVIDER}")
    total = 0
    with conn.cursor() as cur:
        for route in KMB_TEST_ROUTES:
            for direction in ["outbound", "inbound"]:
                dir_code = "O" if direction == "outbound" else "I"
                stops_data = get(f"{KMB_BASE}/route-stop/{route}/{direction}/1")
                stops = stops_data.get("data", [])[:5]
                if not stops:
                    continue
                print(f"  Route {route} {direction}: {len(stops)} stops")

                for stop in stops:
                    stop_id = stop["stop"]

                    # Store stop details
                    sd = get(f"{KMB_BASE}/stop/{stop_id}")
                    if sd.get("data"):
                        d = sd["data"]
                        cur.execute("""
                            INSERT INTO kmb.stops (stop_id, name_en, name_tc, lat, lng)
                            VALUES (%s,%s,%s,%s,%s)
                            ON CONFLICT (stop_id) DO NOTHING
                        """, (stop_id, d.get("name_en"), d.get("name_tc"),
                              float(d["lat"]) if d.get("lat") else None,
                              float(d["long"]) if d.get("long") else None))

                    # Fetch ETA
                    eta_data = get(f"{KMB_BASE}/eta/{stop_id}/{route}/1")
                    for e in eta_data.get("data", [])[:3]:
                        if not e.get("eta"):
                            continue
                        eta_ts = datetime.fromisoformat(e["eta"])
                        wait   = max(0, round((eta_ts - datetime.now(HKT)).total_seconds() / 60))
                        rmk    = e.get("rmk_en", "") or ""
                        is_sch = rmk in ("Scheduled Bus", "")

                        insert_eta(cur, "kmb", route, None, dir_code,
                                   stop_id, e.get("eta_seq", 1),
                                   wait, eta_ts, is_sch, rmk)
                        total += 1

                    time.sleep(0.05)

    conn.commit()
    print(f"  ✅ KMB inserted {total} ETA records")
    return total

# ── CTB ──────────────────────────────────────────────────────
def collect_ctb(conn):
    print(f"\n{DIVIDER}\nCTB — {CTB_TEST_ROUTES}\n{DIVIDER}")
    total = 0
    with conn.cursor() as cur:
        for route in CTB_TEST_ROUTES:
            for direction in ["outbound", "inbound"]:
                dir_code = "O" if direction == "outbound" else "I"
                stops_data = get(f"{CTB_BASE}/route-stop/CTB/{route}/{direction}", timeout=15)
                stops = stops_data.get("data", [])[:5]
                if not stops:
                    continue
                print(f"  Route {route} {direction}: {len(stops)} stops")

                for stop in stops:
                    stop_id = stop["stop"]

                    sd = get(f"{CTB_BASE}/stop/{stop_id}", timeout=15)
                    if sd.get("data"):
                        d = sd["data"]
                        cur.execute("""
                            INSERT INTO ctb.stops (stop_id, name_en, name_tc, lat, lng)
                            VALUES (%s,%s,%s,%s,%s)
                            ON CONFLICT (stop_id) DO NOTHING
                        """, (stop_id, d.get("name_en"), d.get("name_tc"),
                              float(d["lat"]) if d.get("lat") else None,
                              float(d["long"]) if d.get("long") else None))

                    eta_data = get(f"{CTB_BASE}/eta/CTB/{stop_id}/{route}", timeout=15)
                    etas = [e for e in eta_data.get("data", []) if e.get("dir") == dir_code]
                    for e in etas[:3]:
                        if not e.get("eta"):
                            continue
                        eta_ts = datetime.fromisoformat(e["eta"])
                        wait   = max(0, round((eta_ts - datetime.now(HKT)).total_seconds() / 60))
                        rmk    = e.get("rmk_en", "") or ""
                        is_sch = rmk in ("Scheduled Bus", "")

                        insert_eta(cur, "ctb", route, None, dir_code,
                                   stop_id, 1, wait, eta_ts, is_sch, rmk)
                        total += 1

                    time.sleep(0.05)

    conn.commit()
    print(f"  ✅ CTB inserted {total} ETA records")
    return total

# ── GMB ──────────────────────────────────────────────────────
def collect_gmb(conn):
    print(f"\n{DIVIDER}\nGMB — {GMB_TEST}\n{DIVIDER}")
    total = 0
    with conn.cursor() as cur:
        for region, route_code in GMB_TEST:
            print(f"\n  Region={region} Route={route_code}")

            # Step 1: resolve route_id and directions
            r1 = get(f"{GMB_BASE}/route/{region}/{route_code}")
            routes_list = r1.get("data", [])
            if not routes_list:
                print(f"    ⚠ No route data")
                continue

            route_entry = routes_list[0]
            route_id    = route_entry["route_id"]
            print(f"    route_id={route_id}")

            for direction in route_entry.get("directions", []):
                route_seq = direction["route_seq"]

                # Store route info
                cur.execute("""
                    INSERT INTO gmb.routes
                        (route_id, route_seq, route_code, region, orig_en, dest_en)
                    VALUES (%s,%s,%s,%s,%s,%s)
                    ON CONFLICT (route_id, route_seq) DO NOTHING
                """, (route_id, route_seq, route_code, region,
                      direction.get("orig_en"), direction.get("dest_en")))

                # Store headway schedules
                for hw in direction.get("headways", []):
                    cur.execute("""
                        INSERT INTO gmb.headways
                            (route_id, route_seq, start_time, end_time,
                             frequency, is_weekday, is_holiday)
                        VALUES (%s,%s,%s,%s,%s,%s,%s)
                        ON CONFLICT DO NOTHING
                    """, (route_id, route_seq,
                          hw["start_time"], hw["end_time"],
                          hw.get("frequency"),
                          any(hw.get("weekdays", [])),
                          hw.get("public_holiday", False)))

                # Step 2: fetch stops
                r2 = get(f"{GMB_BASE}/route-stop/{route_id}/{route_seq}")
                route_stops = r2.get("data", {}).get("route_stops", [])[:5]
                if not route_stops:
                    continue
                print(f"    route_seq={route_seq}: {len(route_stops)} stops")

                for stop in route_stops:
                    stop_seq = stop["stop_seq"]
                    stop_id  = stop["stop_id"]

                    cur.execute("""
                        INSERT INTO gmb.stops (stop_id, name_en, name_tc, region)
                        VALUES (%s,%s,%s,%s)
                        ON CONFLICT (stop_id) DO NOTHING
                    """, (stop_id, stop.get("name_en"), stop.get("name_tc"), region))

                    # Step 3: fetch ETA
                    r3 = get(f"{GMB_BASE}/eta/route-stop/{route_id}/{route_seq}/{stop_seq}")
                    for e in r3.get("data", {}).get("eta", [])[:3]:
                        diff = e.get("diff")
                        if diff is None:
                            continue
                        wait   = max(0, int(diff))
                        rmk    = e.get("remarks_en", "") or ""
                        is_sch = rmk in ("Scheduled", "")
                        eta_ts = datetime.now(HKT) + timedelta(minutes=diff) if diff >= 0 else None

                        insert_eta(cur, "gmb", route_code, region,
                                   "O" if route_seq == 1 else "I",
                                   stop_id, e.get("eta_seq", 1),
                                   wait, eta_ts, is_sch, rmk,
                                   extra_vals=(route_id, route_code, route_seq))
                        total += 1

                    time.sleep(0.05)

    conn.commit()
    print(f"\n  ✅ GMB inserted {total} ETA records")
    return total

# ── MTR ──────────────────────────────────────────────────────
def collect_mtr(conn):
    print(f"\n{DIVIDER}\nMTR — {MTR_TEST}\n{DIVIDER}")
    total = 0
    with conn.cursor() as cur:
        for line, station in MTR_TEST:
            r = get(f"{MTR_BASE}/getSchedule.php", params={"line": line, "sta": station})
            if r.get("status") != 1:
                print(f"  {line}-{station}: no data")
                continue

            station_data = r.get("data", {}).get(f"{line}-{station}", {})
            print(f"  {line}-{station}:")

            for dir_code, trains in [("UP", station_data.get("UP", [])),
                                     ("DOWN", station_data.get("DOWN", []))]:
                if not trains:
                    continue
                print(f"    {dir_code}: {len(trains)} trains")

                for t in trains[:3]:
                    if not t.get("time") or t.get("valid") != "Y":
                        continue
                    eta_ts = datetime.strptime(t["time"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=HKT)
                    wait   = max(0, round((eta_ts - datetime.now(HKT)).total_seconds() / 60))

                    insert_eta(cur, "mtr", line, None, dir_code,
                               station, int(t.get("seq", 1)),
                               wait, eta_ts, None, None,
                               extra_vals=(line, station, t.get("dest"), t.get("plat")))
                    total += 1

    conn.commit()
    print(f"  ✅ MTR inserted {total} ETA records")
    return total

# ── Verification ──────────────────────────────────────────────
def verify(conn):
    print(f"\n{DIVIDER}\nVERIFICATION\n{DIVIDER}")
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:

        for schema, label in [("kmb", "KMB"), ("ctb", "CTB"),
                               ("gmb", "GMB"), ("mtr", "MTR")]:
            cur.execute(f"""
                SELECT COUNT(*) as records,
                       MIN(wait_minutes) as min_wait,
                       MAX(wait_minutes) as max_wait,
                       ROUND(AVG(wait_minutes)::numeric, 1) as avg_wait
                FROM {schema}.eta
            """)
            row = cur.fetchone()
            print(f"\n  {label}: {row['records']} records | "
                  f"wait min={row['min_wait']}m max={row['max_wait']}m avg={row['avg_wait']}m")

            if schema != "mtr":
                cur.execute(f"""
                    SELECT
                        SUM(CASE WHEN is_scheduled = true  THEN 1 ELSE 0 END) as on_time,
                        SUM(CASE WHEN is_scheduled = false THEN 1 ELSE 0 END) as delayed,
                        COUNT(*) as total
                    FROM {schema}.eta
                """)
                r = cur.fetchone()
                pct = round(r['on_time'] / r['total'] * 100, 1) if r['total'] else 0
                print(f"         on-time={r['on_time']} delayed={r['delayed']} ({pct}% on-time)")

                # Show any delayed remarks
                cur.execute(f"""
                    SELECT DISTINCT remarks FROM {schema}.eta
                    WHERE is_scheduled = false AND remarks != ''
                    LIMIT 5
                """)
                remarks = [row['remarks'] for row in cur.fetchall()]
                if remarks:
                    print(f"         delay remarks: {remarks}")

        # MTR sample
        cur.execute("""
            SELECT line, station, dir, dest, wait_minutes, eta_timestamp
            FROM mtr.eta ORDER BY fetched_at DESC LIMIT 5
        """)
        print(f"\n  MTR sample records:")
        for row in cur.fetchall():
            print(f"    {row['line']}-{row['station']} {row['dir']} "
                  f"→{row['dest']} wait={row['wait_minutes']}m "
                  f"arrives={row['eta_timestamp'].strftime('%H:%M %Z')}")

# ── Main ──────────────────────────────────────────────────────
if __name__ == "__main__":
    print("🚌 HK Transit — Small Scale Collection Test")
    print(f"   Time: {datetime.now(HKT).strftime('%Y-%m-%d %H:%M:%S %Z')}\n")

    conn = psycopg2.connect(**DB)
    try:
        collect_kmb(conn)
        collect_ctb(conn)
        collect_gmb(conn)
        collect_mtr(conn)
        verify(conn)
        print(f"\n✅ Test complete")
    except KeyboardInterrupt:
        print("\n⏹ Interrupted")
    finally:
        conn.close()
