import csv
import io
import os
from datetime import date

import psycopg2
import requests
from psycopg2.extras import execute_values
from flask import Flask, request, jsonify

app = Flask(__name__)

DB = {
    "host":     os.getenv("DB_HOST", "localhost"),
    "port":     int(os.getenv("DB_PORT", 5432)),
    "dbname":   os.getenv("DB_NAME", "hkbus"),
    "user":     os.getenv("DB_USER", "postgres"),
    "password": os.getenv("DB_PASSWORD", "postgres"),
}

DAY_MAP = {
    "Monday": 2, "Tuesday": 3, "Wednesday": 4, "Thursday": 5,
    "Friday": 6, "Saturday": 7, "Sunday": 1,
}

# HK coordinates (HK Observatory, Tsim Sha Tsui)
HK_LAT, HK_LON = 22.3019, 114.1745


def get_conn():
    return psycopg2.connect(**DB)


def fetch_csv(url):
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    return list(csv.DictReader(io.StringIO(r.text.lstrip("﻿"))))


def fetch_weather_stats(years):
    """Fetch wet/dry day counts from Open-Meteo for each year."""
    stats = {}
    for year in years:
        try:
            url = (
                f"https://archive-api.open-meteo.com/v1/archive"
                f"?latitude={HK_LAT}&longitude={HK_LON}"
                f"&start_date={year}-01-01&end_date={year}-12-31"
                f"&daily=precipitation_sum&timezone=Asia/Hong_Kong"
            )
            r = requests.get(url, timeout=30)
            r.raise_for_status()
            data = r.json()
            precip = data["daily"]["precipitation_sum"]
            # HKO defines a rain day as >= 1.0 mm (station), but Open-Meteo uses ERA5 reanalysis
            # which over-counts light drizzle for coastal HK. >= 5.0 mm empirically matches
            # HKO's published ~103 rain days/year baseline from actual station records.
            wet = sum(1 for v in precip if v is not None and v >= 5.0)
            total = sum(1 for v in precip if v is not None)
            stats[year] = {"wet_days": wet, "dry_days": total - wet, "total_days": total}
        except Exception:
            pass
    return stats


@app.route("/healthz")
def healthz():
    return jsonify({"status": "ok"})


@app.route("/", methods=["POST"])
def handle():
    all_rows = []
    accident_years = set()

    # Auto-discover available years — probe sequentially from 2021 until a 404 is hit
    current_year = date.today().year
    available_years = []
    for y in range(2021, current_year + 1):
        probe = f"https://www.td.gov.hk/datagovhk_td/rt-accidentstat-{y}/resources/f2.6_eng.csv"
        try:
            if requests.head(probe, timeout=10).status_code == 200:
                available_years.append(y)
            else:
                break
        except Exception:
            break

    for year in available_years:
        base = f"https://www.td.gov.hk/datagovhk_td/rt-accidentstat-{year}/resources/"

        # Accidents by hour of day (f2.5)
        try:
            rows_raw = fetch_csv(base + "f2.5_eng.csv")
            keys = list(rows_raw[0].keys())
            item_key = next(k for k in keys if "Item" in k)
            hour_key = next(k for k in keys if "Hour" in k or "hour" in k.lower())
            for row in rows_raw:
                if row.get(item_key, "").strip() != "Number":
                    continue
                hour_str = row.get(hour_key, "").strip()
                if not hour_str or not hour_str[0].isdigit():
                    continue
                hour_of_day = int(hour_str[:2])
                for day_name, dow in DAY_MAP.items():
                    try:
                        all_rows.append((year, hour_of_day, dow, None, None, None, "All", int(row[day_name])))
                        accident_years.add(year)
                    except (KeyError, ValueError):
                        pass
        except Exception:
            pass

        # Accidents by district (f2.6)
        try:
            rows_raw = fetch_csv(base + "f2.6_eng.csv")
            keys = list(rows_raw[0].keys())
            dist_key    = keys[0]
            fatal_key   = next(k for k in keys if "Fatal" in k)
            serious_key = next(k for k in keys if "Serious" in k)
            slight_key  = next(k for k in keys if "Slight" in k)
            for row in rows_raw:
                district = row.get(dist_key, "").strip()
                if district.endswith(": All") or district in ("All", ""):
                    continue
                for severity, key in [("Fatal", fatal_key), ("Serious", serious_key), ("Slight", slight_key)]:
                    try:
                        all_rows.append((year, None, None, district, None, None, severity, int(row[key])))
                        accident_years.add(year)
                    except (KeyError, ValueError):
                        pass
        except Exception:
            pass

        # Accidents by road condition + type (f2.7)
        try:
            rows_raw = fetch_csv(base + "f2.7_eng.csv")
            keys = list(rows_raw[0].keys())
            type_key = keys[0]
            sev_key  = keys[1]
            wet_key  = next(k for k in keys if "Wet" in k)
            dry_key  = next(k for k in keys if "Dry" in k)
            unk_key  = next(k for k in keys if "Unknown" in k)
            for row in rows_raw:
                acc_type = row.get(type_key, "").strip()
                severity = row.get(sev_key,  "").strip()
                if acc_type in ("All types", "") or severity == "All":
                    continue
                for condition, key in [("Wet", wet_key), ("Dry", dry_key), ("Unknown", unk_key)]:
                    try:
                        all_rows.append((year, None, None, None, acc_type, condition, severity, int(row[key])))
                        accident_years.add(year)
                    except (KeyError, ValueError):
                        pass
        except Exception:
            pass

    # Multi-year trend (f2.2) — use the latest discovered year for the most up-to-date file
    latest_year = max(available_years) if available_years else 2024
    try:
        rows_raw = fetch_csv(f"https://www.td.gov.hk/datagovhk_td/rt-accidentstat-{latest_year}/resources/f2.2_eng.csv")
        keys = list(rows_raw[0].keys())
        type_key  = keys[0]
        sev_key   = keys[1]
        year_keys = [k for k in keys if k.strip().isdigit() and int(k.strip()) >= 2021]
        for row in rows_raw:
            acc_type = row.get(type_key, "").strip()
            severity = row.get(sev_key,  "").strip()
            if acc_type == "All types" or severity == "All":
                continue
            for yk in year_keys:
                try:
                    y = int(yk.strip())
                    all_rows.append((y, None, None, None, acc_type, None, severity, int(row[yk])))
                    accident_years.add(y)
                except (KeyError, ValueError):
                    pass
    except Exception:
        pass

    # Fetch real wet/dry day counts from Open-Meteo for all years found
    weather_stats = fetch_weather_stats(accident_years)

    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute("TRUNCATE TABLE accident_summary")
        if all_rows:
            execute_values(cur, """
                INSERT INTO accident_summary
                  (year, hour_of_day, day_of_week, district, accident_type, road_condition, severity, count)
                VALUES %s
            """, all_rows)

        # Upsert weather stats
        for year, ws in weather_stats.items():
            cur.execute("""
                INSERT INTO weather_annual_stats (year, wet_days, dry_days, total_days, updated_at)
                VALUES (%s, %s, %s, %s, NOW())
                ON CONFLICT (year) DO UPDATE
                  SET wet_days   = EXCLUDED.wet_days,
                      dry_days   = EXCLUDED.dry_days,
                      total_days = EXCLUDED.total_days,
                      updated_at = EXCLUDED.updated_at
            """, (year, ws["wet_days"], ws["dry_days"], ws["total_days"]))

    conn.commit()
    conn.close()
    return jsonify({"ok": True, "inserted": len(all_rows), "weather_years": weather_stats})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
