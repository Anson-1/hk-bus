import csv
import datetime
import io
import os

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

IMMD_URL = (
    "https://www.immd.gov.hk/opendata/eng/transport/immigration_clearance/"
    "statistics_on_daily_passenger_traffic.csv"
)

LUNAR_NEW_YEAR = {
    "2021": ("2021-02-11", "2021-02-17"),
    "2022": ("2022-02-01", "2022-02-07"),
    "2023": ("2023-01-22", "2023-01-28"),
    "2024": ("2024-02-10", "2024-02-16"),
    "2025": ("2025-01-29", "2025-02-04"),
    "2026": ("2026-02-17", "2026-02-23"),
}


def get_conn():
    return psycopg2.connect(**DB)


def _build_lunar_set():
    lunar = set()
    for start, end in LUNAR_NEW_YEAR.values():
        d = datetime.date.fromisoformat(start)
        while d <= datetime.date.fromisoformat(end):
            lunar.add(d.isoformat())
            d += datetime.timedelta(days=1)
    return lunar


def _fetch_holidays():
    try:
        r = requests.get("https://www.1823.gov.hk/common/ical/en.json", timeout=30)
        data = r.json()
        holidays = {}
        for item in data.get("vcalendar", [{}])[0].get("vevent", []):
            raw = (item.get("dtstart") or [""])[0]
            s = str(raw)
            if len(s) == 8:
                holidays[f"{s[:4]}-{s[4:6]}-{s[6:]}"] = item.get("summary", "Public Holiday")
        return holidays
    except Exception:
        return {}


def _classify(d, holidays, lunar):
    ds = d.isoformat()
    if ds in lunar:
        return True, "Lunar New Year", "Lunar New Year"
    if ds in holidays:
        return True, holidays[ds], "Public Holiday"
    if d.isoweekday() >= 6:
        return False, None, "Weekend"
    return False, None, "Weekday"


def _safe_int(v):
    try:
        return int(str(v).replace(",", "").strip())
    except (ValueError, TypeError):
        return None


@app.route("/healthz")
def healthz():
    return jsonify({"status": "ok"})


@app.route("/", methods=["POST"])
def handle():
    r = requests.get(IMMD_URL, timeout=120)
    r.raise_for_status()
    reader = list(csv.DictReader(io.StringIO(r.text.lstrip("﻿"))))
    if not reader:
        return jsonify({"ok": True, "inserted": 0, "message": "empty CSV"})

    sample   = reader[0]
    date_key = next(k for k in sample if "Date" in k or "date" in k.lower())
    cp_key   = next(k for k in sample if "Control" in k)
    dir_key  = next((k for k in sample if "Arrival" in k or "Departure" in k), list(sample.keys())[2])
    hkr_key  = next(k for k in sample if "Hong Kong" in k)
    mvr_key  = next(k for k in sample if "Mainland" in k)
    ovr_key  = next(k for k in sample if "Other" in k)
    tot_key  = next(k for k in sample if "Total" in k)

    holidays = _fetch_holidays()
    lunar    = _build_lunar_set()

    batch = []
    for row in reader:
        try:
            date_val = datetime.datetime.strptime(row[date_key].strip(), "%d-%m-%Y").date()
            if date_val < datetime.date(2021, 1, 1):
                continue
            total = _safe_int(row[tot_key])
            if total is None:
                continue
            is_ph, hname, day_type = _classify(date_val, holidays, lunar)
            batch.append((
                date_val,
                row[cp_key].strip(),
                row[dir_key].strip(),
                _safe_int(row[hkr_key]),
                _safe_int(row[mvr_key]),
                _safe_int(row[ovr_key]),
                total,
                is_ph,
                hname,
                day_type,
            ))
        except Exception:
            continue

    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute("TRUNCATE TABLE passenger_daily_summary")
        if batch:
            execute_values(cur, """
                INSERT INTO passenger_daily_summary
                  (date, control_point, direction, hk_residents, mainland_visitors,
                   other_visitors, total, is_public_holiday, holiday_name, day_type)
                VALUES %s
            """, batch)
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "inserted": len(batch)})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
