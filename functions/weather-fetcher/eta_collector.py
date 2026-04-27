import time
import logging
import os
from datetime import datetime, timezone
import requests
import psycopg2
from psycopg2.extras import execute_values

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger(__name__)

STOPS_91M_OUTBOUND = [
    "796CAA794D4DEBE8", "FC42DCBDC3AB0B6F", "22E2678081E88368", "7613538D58A9C452",
    "9B0382206D441221", "29A07F043B4D5919", "87CD68EAD90352E9", "78AE8E07840D1CF7",
    "5146FB43555E8310", "7297BDBB8A758AD5", "1D7BC9F560C3B0CC", "FDA55F46899FC5D0",
    "B002CEF0DBC568F5", "A79D111EB948F013", "298847E9FCC94FD9", "86DF43320DF0F596",
    "36F2D783428B6307", "EBA1C02EA9906C96", "47B8E78BAB4FEB5D", "0BE9DE9BA299E126",
    "4D55F6240E2AAFB8", "C58FCEE9339E5319", "1EF5FAB9266BD6C8", "5D77A5CBE41F2984",
    "18F3C20116BFE83D", "332F374B6CB17C57", "7ABFD50CAA98A9D1", "A0FDF34B2D278750",
    "53889000AA9C33E2",
]

KMB_ETA_URL = "https://data.etabus.gov.hk/v1/transport/kmb/eta/{stop}/91M/1"

DB_CONFIG = {
    "host": os.getenv("POSTGRES_HOST", "localhost"),
    "port": int(os.getenv("POSTGRES_PORT", 5432)),
    "dbname": os.getenv("POSTGRES_DB", "hk_bus"),
    "user": os.getenv("POSTGRES_USER", "postgres"),
    "password": os.getenv("POSTGRES_PASSWORD", "postgres"),
}

FETCH_INTERVAL = int(os.getenv("FETCH_INTERVAL_SEC", 30))


def get_db():
    for attempt in range(10):
        try:
            conn = psycopg2.connect(**DB_CONFIG)
            conn.autocommit = True
            return conn
        except psycopg2.OperationalError as e:
            log.warning("DB connect failed (attempt %d/10): %s", attempt + 1, e)
            time.sleep(5)
    raise RuntimeError("Cannot connect to PostgreSQL after 10 attempts")


def fetch_stop_eta(stop_id: str, session: requests.Session) -> list[dict]:
    url = KMB_ETA_URL.format(stop=stop_id)
    try:
        resp = session.get(url, timeout=10)
        resp.raise_for_status()
        data = resp.json().get("data", [])
        return [d for d in data if d.get("eta")]
    except Exception as e:
        log.warning("Failed fetching stop %s: %s", stop_id, e)
        return []


def parse_wait_sec(eta_str: str, generated_str: str) -> int | None:
    try:
        fmt = "%Y-%m-%dT%H:%M:%S%z"
        eta_dt = datetime.strptime(eta_str, fmt)
        gen_dt = datetime.strptime(generated_str, fmt)
        wait = int((eta_dt - gen_dt).total_seconds())
        return wait if wait >= 0 else None
    except Exception:
        return None


def collect_and_store(conn, session: requests.Session):
    rows = []
    fetched_at = datetime.now(timezone.utc)

    for stop_id in STOPS_91M_OUTBOUND:
        etas = fetch_stop_eta(stop_id, session)
        for entry in etas:
            wait_sec = parse_wait_sec(
                entry.get("eta", ""),
                entry.get("data_timestamp", ""),
            )
            if wait_sec is None:
                continue
            rows.append((
                entry.get("route", "91M"),
                entry.get("dir", "O"),
                stop_id,
                wait_sec,
                wait_sec > 900,  # delay_flag: >15 min considered delayed
                fetched_at,
            ))

    if not rows:
        log.info("No ETA data returned this cycle")
        return

    with conn.cursor() as cur:
        execute_values(
            cur,
            """INSERT INTO eta_raw (route, dir, stop_id, wait_sec, delay_flag, fetched_at)
               VALUES %s""",
            rows,
        )
    log.info("Inserted %d ETA records", len(rows))


def main():
    log.info("ETA collector starting — Route 91M, %d stops, interval %ds",
             len(STOPS_91M_OUTBOUND), FETCH_INTERVAL)
    conn = get_db()
    session = requests.Session()
    session.headers["User-Agent"] = "hk-bus-eta-collector/1.0"

    while True:
        try:
            collect_and_store(conn, session)
        except psycopg2.Error as e:
            log.error("DB error, reconnecting: %s", e)
            try:
                conn.close()
            except Exception:
                pass
            conn = get_db()
        except Exception as e:
            log.error("Unexpected error: %s", e)
        time.sleep(FETCH_INTERVAL)


if __name__ == "__main__":
    main()
