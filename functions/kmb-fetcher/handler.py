import json
import os
from datetime import datetime, timezone
import requests
from kafka import KafkaProducer

KMB_BASE = "https://data.etabus.gov.hk/v1/transport/kmb"
KAFKA_BROKER = os.environ.get("KAFKA_BROKER", "kafka:9092")
KAFKA_TOPIC = os.environ.get("KAFKA_TOPIC", "kmb-eta-raw")
CONFIG_PATH = os.path.join(os.path.dirname(__file__), "stops_config.json")


def load_config() -> dict:
    with open(CONFIG_PATH) as f:
        return json.load(f)


def fetch_stop_eta(stop_id: str) -> list:
    url = f"{KMB_BASE}/stop-eta/{stop_id}"
    resp = requests.get(url, timeout=10)
    resp.raise_for_status()
    fetched_at = datetime.now(timezone.utc).isoformat()
    records = resp.json().get("data", [])
    for r in records:
        r["fetched_at"] = fetched_at
    return records


def filter_records(records: list, routes: list) -> list:
    return [r for r in records if r.get("route") in routes]


def build_kafka_message(record: dict) -> str:
    return json.dumps({
        "co": record.get("co"),
        "route": record.get("route"),
        "dir": record.get("dir"),
        "service_type": record.get("service_type"),
        "seq": record.get("seq"),
        "stop": record.get("stop"),
        "dest_en": record.get("dest_en"),
        "eta_seq": record.get("eta_seq"),
        "eta": record.get("eta"),
        "rmk_en": record.get("rmk_en", ""),
        "data_timestamp": record.get("data_timestamp"),
        "fetched_at": record.get("fetched_at"),
    })


def handle(req):
    config = load_config()
    stop_ids = config["stop_ids"]
    routes = config["routes"]

    producer = KafkaProducer(bootstrap_servers=KAFKA_BROKER)
    published = 0

    for stop_id in stop_ids:
        try:
            records = fetch_stop_eta(stop_id)
            filtered = filter_records(records, routes)
            for record in filtered:
                msg = build_kafka_message(record)
                producer.send(KAFKA_TOPIC, msg.encode("utf-8"))
                published += 1
        except Exception as e:
            print(f"Error fetching stop {stop_id}: {e}")

    producer.flush()
    return f"Published {published} ETA records"


if __name__ == "__main__":
    print(handle(""))
