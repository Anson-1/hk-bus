import csv
import io
import os
from datetime import datetime, timezone
from xml.etree import ElementTree as ET

import psycopg2
import requests
from psycopg2.extras import execute_values
from flask import Flask, request, jsonify

app = Flask(__name__)

XML_URL = "https://resource.data.one.gov.hk/td/traffic-detectors/rawSpeedVol_SLP-all.xml"
LOC_URL = "https://static.data.gov.hk/td/traffic-data-slp/info/traffic_speed_volume_occ_info-slp.csv"

DB = {
    "host":     os.getenv("DB_HOST", "localhost"),
    "port":     int(os.getenv("DB_PORT", 5432)),
    "dbname":   os.getenv("DB_NAME", "hkbus"),
    "user":     os.getenv("DB_USER", "postgres"),
    "password": os.getenv("DB_PASSWORD", "postgres"),
}


def get_conn():
    return psycopg2.connect(**DB)


@app.route("/healthz")
def healthz():
    return jsonify({"status": "ok"})


@app.route("/", methods=["POST"])
def handle():
    conn = get_conn()
    conn.autocommit = True

    # Seed detector locations once
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM traffic_detector_locations")
        if cur.fetchone()[0] == 0:
            resp = requests.get(LOC_URL, timeout=30)
            resp.raise_for_status()
            reader = csv.DictReader(io.StringIO(resp.content.decode("utf-8-sig")))
            loc_rows = []
            for row in reader:
                try:
                    loc_rows.append((
                        row["AID_ID_Number"].strip(),
                        row["District"].strip(),
                        row["Road_EN"].strip(),
                        float(row["Latitude"]) if row.get("Latitude", "").strip() else None,
                        float(row["Longitude"]) if row.get("Longitude", "").strip() else None,
                        row.get("Direction", "").strip(),
                    ))
                except (KeyError, ValueError):
                    continue
            if loc_rows:
                execute_values(cur,
                    "INSERT INTO traffic_detector_locations (aid_id,district,road_en,latitude,longitude,direction) VALUES %s ON CONFLICT (aid_id) DO NOTHING",
                    loc_rows)

    # Fetch latest speed/volume XML
    resp = requests.get(XML_URL, timeout=30)
    resp.raise_for_status()
    root = ET.fromstring(resp.content)

    report_date_str = root.findtext("date", "").strip()
    try:
        report_date = datetime.strptime(report_date_str, "%Y-%m-%d").date()
    except ValueError:
        report_date = datetime.now(timezone.utc).date()

    periods = root.findall(".//period")
    if not periods:
        conn.close()
        return jsonify({"ok": True, "inserted": 0, "message": "no periods in XML"})

    latest = periods[-1]
    period_from = latest.findtext("period_from", "").strip() or None
    period_to   = latest.findtext("period_to",   "").strip() or None

    rows = []
    for detector in latest.findall(".//detector"):
        det_id    = detector.findtext("detector_id", "").strip()
        direction = detector.findtext("direction",   "").strip()
        for lane in detector.findall(".//lane"):
            if lane.findtext("valid", "N").strip() != "Y":
                continue
            try:
                speed     = int(lane.findtext("speed",     "0"))
                volume    = int(lane.findtext("volume",    "0"))
                occupancy = float(lane.findtext("occupancy", "0"))
            except (ValueError, TypeError):
                continue
            if speed <= 0 and volume <= 0:
                continue
            rows.append((
                det_id, direction,
                lane.findtext("lane_id", "").strip(),
                speed, volume, occupancy,
                period_from, period_to, report_date,
            ))

    with conn.cursor() as cur:
        if rows:
            execute_values(cur, """
                INSERT INTO traffic_speed_volume
                  (detector_id, direction, lane_id, speed, volume, occupancy,
                   period_from, period_to, report_date)
                VALUES %s
            """, rows)
        cur.execute("DELETE FROM traffic_speed_volume WHERE fetched_at < NOW() - INTERVAL '24 hours'")

    conn.close()
    return jsonify({"ok": True, "inserted": len(rows)})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
