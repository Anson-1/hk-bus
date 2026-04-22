import json
import os
import requests

KMB_BASE = "https://data.etabus.gov.hk/v1/transport/kmb"
TARGET_ROUTES = [
    "1", "1A", "2", "3C", "5", "6", "6C", "9", "11", "12",
    "13D", "15", "26", "40", "42C", "68X", "74B", "98D", "270", "N8",
    "91M", "91P"
]
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "..", "functions", "kmb-fetcher", "stops_config.json")


def fetch_stops_for_route(route: str, direction: str, service_type: str) -> list:
    url = f"{KMB_BASE}/route-stop/{route}/{direction}/{service_type}"
    resp = requests.get(url, timeout=10)
    resp.raise_for_status()
    return [item["stop"] for item in resp.json().get("data", [])]


def build_stops_config(routes: list, stops_by_route: dict) -> dict:
    all_stops = list({stop for stops in stops_by_route.values() for stop in stops})
    return {"routes": routes, "stop_ids": all_stops}


def main():
    stops_by_route = {}
    for route in TARGET_ROUTES:
        for direction in ["outbound", "inbound"]:
            try:
                stops = fetch_stops_for_route(route, direction, "1")
                if stops:
                    key = f"{route}_{direction}"
                    stops_by_route[key] = stops
                    print(f"  {route} {direction}: {len(stops)} stops")
            except Exception as e:
                print(f"  Skipping {route} {direction}: {e}")

    config = build_stops_config(TARGET_ROUTES, stops_by_route)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(config, f, indent=2)
    print(f"\nWrote {len(config['stop_ids'])} unique stop IDs to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
