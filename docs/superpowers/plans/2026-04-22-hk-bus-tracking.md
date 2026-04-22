# HK Bus Tracking System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a serverless real-time Hong Kong (KMB) bus ETA tracking system on Kubernetes, using OpenFaaS, Kafka, Spark, PostgreSQL, and Grafana as open-source replacements for AWS Lambda, Kinesis, EMR, DynamoDB, and QuickSight.

**Architecture:** An OpenFaaS function (`kmb-fetcher`) is cron-triggered every 30 seconds to fetch ETA data from the KMB public API and publish JSON records to a Kafka topic. Spark Streaming consumes that topic in 1-minute windows to detect delays and write aggregates to PostgreSQL. A Spark Batch CronJob runs hourly to compute historical analytics. Grafana reads PostgreSQL and displays three live dashboards.

**Tech Stack:** Python 3.11, kafka-python, requests, PySpark 3.x, psycopg2-binary, pytest, Docker, Kubernetes (Docker Desktop built-in), OpenFaaS (faas-netes via Helm), Bitnami Kafka Helm chart, kube-prometheus-stack Helm chart, Grafana.

---

> **Boundary note:** Tasks 1–7 produce code testable locally (no Docker needed — Spark runs in local mode, Kafka/HTTP calls are mocked). Tasks 8–14 produce Kubernetes manifests and Grafana config that require the cluster machine (Mac with Docker Desktop + Kubernetes enabled).

---

## File Map

```
hk-bus/
├── functions/kmb-fetcher/
│   ├── handler.py          # OpenFaaS entry point — fetches KMB API, publishes to Kafka
│   ├── requirements.txt    # requests, kafka-python
│   └── Dockerfile          # Python 3.11-slim base, copies handler + stops.json
├── scripts/
│   └── bootstrap_stops.py  # One-time: calls KMB API, writes stops.json
├── spark/
│   ├── streaming_job.py    # Spark Structured Streaming: reads Kafka, writes eta_realtime + eta_raw
│   └── batch_job.py        # Spark Batch: reads eta_raw, writes eta_analytics
├── k8s/
│   ├── namespace.yaml
│   ├── kafka/
│   │   ├── zookeeper.yaml  # StatefulSet + Service
│   │   └── kafka.yaml      # StatefulSet + Service (NodePort for debug)
│   ├── postgres/
│   │   ├── postgres.yaml   # StatefulSet + PVC + Service
│   │   └── init.sql        # CREATE TABLE statements
│   ├── spark/
│   │   ├── streaming-deployment.yaml   # Deployment: always-running Spark Streaming
│   │   └── batch-cronjob.yaml          # CronJob: hourly Spark Batch
│   ├── grafana/
│   │   └── grafana.yaml    # Deployment + ConfigMap (dashboards) + NodePort Service
│   └── openfaas/
│       └── kmb-fetcher-fn.yaml  # OpenFaaS Function CR with cron trigger
├── grafana/dashboards/
│   ├── data-dashboard.json
│   ├── analytics-dashboard.json
│   └── infra-dashboard.json
├── tests/
│   ├── test_handler.py         # Unit tests for kmb-fetcher handler
│   ├── test_bootstrap.py       # Unit tests for bootstrap_stops
│   ├── test_streaming_job.py   # Unit tests for Spark transformations
│   └── test_batch_job.py       # Unit tests for Spark batch transformations
├── docker-compose.yml          # Kafka + ZK + Postgres for smoke testing on cluster machine
└── README.md
```

---

## Task 1: Project Scaffold

**Files:**
- Create: `functions/kmb-fetcher/requirements.txt`
- Create: `functions/kmb-fetcher/stops_config.json` (placeholder)
- Create: `requirements-dev.txt`
- Create: `.gitignore`

- [ ] **Step 1: Initialise git and create directory structure**

```bash
cd /Users/hk00635ml/Desktop/hk-bus
git init
mkdir -p functions/kmb-fetcher scripts spark k8s/kafka k8s/postgres k8s/spark k8s/grafana k8s/openfaas grafana/dashboards tests docs/superpowers/plans
```

- [ ] **Step 2: Create `.gitignore`**

```
__pycache__/
*.pyc
*.egg-info/
.pytest_cache/
.venv/
venv/
*.log
stops.json
```

- [ ] **Step 3: Create `requirements-dev.txt`**

```
pytest==7.4.3
pytest-mock==3.12.0
requests-mock==1.11.0
```

- [ ] **Step 4: Create `functions/kmb-fetcher/requirements.txt`**

```
requests==2.31.0
kafka-python==2.0.2
```

- [ ] **Step 5: Create placeholder `functions/kmb-fetcher/stops_config.json`**

```json
{
  "routes": ["1", "1A", "2", "3C", "5", "6", "6C", "9", "11", "12", "13D", "15", "26", "40", "42C", "68X", "74B", "98D", "270", "N8"],
  "stop_ids": []
}
```

- [ ] **Step 6: Install dev dependencies**

```bash
pip install -r requirements-dev.txt
```

- [ ] **Step 7: Commit**

```bash
git add .
git commit -m "chore: initial project scaffold"
```

---

## Task 2: Bootstrap Stops Script

**Files:**
- Create: `scripts/bootstrap_stops.py`
- Create: `tests/test_bootstrap.py`

The script calls the KMB API once at setup time to discover all stop IDs for the target routes and writes them to `functions/kmb-fetcher/stops_config.json`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_bootstrap.py`:

```python
import json
import pytest
from unittest.mock import patch, MagicMock
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
from bootstrap_stops import fetch_stops_for_route, build_stops_config


FAKE_ROUTE_STOP_RESPONSE = {
    "data": [
        {"co": "KMB", "route": "1A", "bound": "O", "service_type": "1", "seq": 1, "stop": "STOP_AAA"},
        {"co": "KMB", "route": "1A", "bound": "O", "service_type": "1", "seq": 2, "stop": "STOP_BBB"},
    ]
}


def test_fetch_stops_for_route_returns_stop_ids():
    with patch('bootstrap_stops.requests.get') as mock_get:
        mock_response = MagicMock()
        mock_response.json.return_value = FAKE_ROUTE_STOP_RESPONSE
        mock_response.raise_for_status = MagicMock()
        mock_get.return_value = mock_response

        stops = fetch_stops_for_route("1A", "O", "1")

    assert stops == ["STOP_AAA", "STOP_BBB"]
    mock_get.assert_called_once_with(
        "https://data.etabus.gov.hk/v1/transport/kmb/route-stop/1A/O/1",
        timeout=10
    )


def test_fetch_stops_for_route_handles_empty_data():
    with patch('bootstrap_stops.requests.get') as mock_get:
        mock_response = MagicMock()
        mock_response.json.return_value = {"data": []}
        mock_response.raise_for_status = MagicMock()
        mock_get.return_value = mock_response

        stops = fetch_stops_for_route("1A", "O", "1")

    assert stops == []


def test_build_stops_config_deduplicates():
    stops_by_route = {
        "1A": ["STOP_AAA", "STOP_BBB"],
        "2": ["STOP_BBB", "STOP_CCC"],
    }
    config = build_stops_config(["1A", "2"], stops_by_route)
    assert sorted(config["stop_ids"]) == ["STOP_AAA", "STOP_BBB", "STOP_CCC"]
    assert config["routes"] == ["1A", "2"]
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pytest tests/test_bootstrap.py -v
```
Expected: `ModuleNotFoundError: No module named 'bootstrap_stops'`

- [ ] **Step 3: Write `scripts/bootstrap_stops.py`**

```python
import json
import os
import requests

KMB_BASE = "https://data.etabus.gov.hk/v1/transport/kmb"
TARGET_ROUTES = [
    "1", "1A", "2", "3C", "5", "6", "6C", "9", "11", "12",
    "13D", "15", "26", "40", "42C", "68X", "74B", "98D", "270", "N8"
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
        for direction in ["O", "I"]:
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pytest tests/test_bootstrap.py -v
```
Expected: all 3 tests PASS

- [ ] **Step 5: Run the bootstrap script to generate stops_config.json (requires internet)**

```bash
python scripts/bootstrap_stops.py
```
Expected output: lines like `1A O: 34 stops`, then `Wrote NNN unique stop IDs to functions/kmb-fetcher/stops_config.json`

- [ ] **Step 6: Commit**

```bash
git add scripts/bootstrap_stops.py tests/test_bootstrap.py functions/kmb-fetcher/stops_config.json
git commit -m "feat: bootstrap stops script with unit tests"
```

---

## Task 3: KMB Fetcher OpenFaaS Handler

**Files:**
- Create: `functions/kmb-fetcher/handler.py`
- Create: `tests/test_handler.py`

The handler loads `stops_config.json`, calls `/stop-eta/{stop_id}` for every stop, filters to target routes, and publishes each ETA record to Kafka.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_handler.py`:

```python
import json
import pytest
from unittest.mock import patch, MagicMock, call
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'functions', 'kmb-fetcher'))

FAKE_STOP_ETA_RESPONSE = {
    "data": [
        {
            "co": "KMB", "route": "1A", "dir": "O", "service_type": "1",
            "seq": 1, "stop": "STOP_AAA", "dest_en": "STAR FERRY",
            "eta_seq": 1, "eta": "2026-04-22T14:32:00+08:00",
            "rmk_en": "", "data_timestamp": "2026-04-22T14:28:00+08:00"
        },
        {
            "co": "KMB", "route": "999X", "dir": "O", "service_type": "1",
            "seq": 1, "stop": "STOP_AAA", "dest_en": "SOMEWHERE",
            "eta_seq": 1, "eta": "2026-04-22T14:33:00+08:00",
            "rmk_en": "", "data_timestamp": "2026-04-22T14:28:00+08:00"
        }
    ]
}

FAKE_CONFIG = {
    "routes": ["1A", "2"],
    "stop_ids": ["STOP_AAA", "STOP_BBB"]
}


def test_fetch_stop_eta_returns_filtered_records():
    with patch('handler.requests.get') as mock_get:
        mock_resp = MagicMock()
        mock_resp.json.return_value = FAKE_STOP_ETA_RESPONSE
        mock_resp.raise_for_status = MagicMock()
        mock_get.return_value = mock_resp

        from handler import fetch_stop_eta, filter_records
        records = fetch_stop_eta("STOP_AAA")
        filtered = filter_records(records, ["1A", "2"])

    assert len(filtered) == 1
    assert filtered[0]["route"] == "1A"


def test_fetch_stop_eta_adds_fetched_at():
    with patch('handler.requests.get') as mock_get:
        mock_resp = MagicMock()
        mock_resp.json.return_value = FAKE_STOP_ETA_RESPONSE
        mock_resp.raise_for_status = MagicMock()
        mock_get.return_value = mock_resp

        from handler import fetch_stop_eta
        records = fetch_stop_eta("STOP_AAA")

    assert all("fetched_at" in r for r in records)


def test_build_kafka_message_structure():
    from handler import build_kafka_message
    record = FAKE_STOP_ETA_RESPONSE["data"][0]
    msg = build_kafka_message(record)
    parsed = json.loads(msg)
    required_keys = ["co", "route", "dir", "service_type", "seq", "stop",
                     "dest_en", "eta_seq", "eta", "rmk_en", "data_timestamp", "fetched_at"]
    for key in required_keys:
        assert key in parsed, f"Missing key: {key}"


def test_handle_publishes_filtered_records_to_kafka():
    with patch('handler.load_config', return_value=FAKE_CONFIG), \
         patch('handler.fetch_stop_eta') as mock_fetch, \
         patch('handler.KafkaProducer') as mock_producer_cls:

        mock_fetch.return_value = FAKE_STOP_ETA_RESPONSE["data"]
        mock_producer = MagicMock()
        mock_producer_cls.return_value = mock_producer

        from handler import handle
        handle("")

    # Two stop IDs → two fetch calls
    assert mock_fetch.call_count == 2
    # Only 1A records pass filter (not 999X) → 2 stops × 1 matching record = 2 sends
    assert mock_producer.send.call_count == 2
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pytest tests/test_handler.py -v
```
Expected: `ModuleNotFoundError: No module named 'handler'`

- [ ] **Step 3: Write `functions/kmb-fetcher/handler.py`**

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pytest tests/test_handler.py -v
```
Expected: all 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add functions/kmb-fetcher/handler.py tests/test_handler.py
git commit -m "feat: KMB fetcher OpenFaaS handler with unit tests"
```

---

## Task 4: Fetcher Dockerfile

**Files:**
- Create: `functions/kmb-fetcher/Dockerfile`

- [ ] **Step 1: Write `functions/kmb-fetcher/Dockerfile`**

```dockerfile
FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY handler.py .
COPY stops_config.json .

ENV KAFKA_BROKER=kafka:9092
ENV KAFKA_TOPIC=kmb-eta-raw

CMD ["python", "handler.py"]
```

- [ ] **Step 2: Commit**

```bash
git add functions/kmb-fetcher/Dockerfile
git commit -m "feat: fetcher Dockerfile"
```

---

## Task 5: PostgreSQL Schema

**Files:**
- Create: `k8s/postgres/init.sql`

- [ ] **Step 1: Write `k8s/postgres/init.sql`**

```sql
CREATE DATABASE hkbus;
\c hkbus;

-- Raw archive — every ETA record ingested
CREATE TABLE IF NOT EXISTS eta_raw (
    id            SERIAL PRIMARY KEY,
    co            VARCHAR(10),
    route         VARCHAR(10)   NOT NULL,
    dir           CHAR(1)       NOT NULL,
    stop          VARCHAR(64)   NOT NULL,
    eta_seq       INT,
    eta           TIMESTAMPTZ,
    rmk_en        TEXT,
    data_timestamp TIMESTAMPTZ,
    fetched_at    TIMESTAMPTZ   NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eta_raw_route ON eta_raw (route, dir);
CREATE INDEX IF NOT EXISTS idx_eta_raw_fetched ON eta_raw (fetched_at);

-- Spark Streaming output — 1-minute window aggregates
CREATE TABLE IF NOT EXISTS eta_realtime (
    route         VARCHAR(10)   NOT NULL,
    dir           CHAR(1)       NOT NULL,
    window_start  TIMESTAMPTZ   NOT NULL,
    avg_wait_sec  FLOAT,
    delay_flag    BOOLEAN,
    sample_count  INT,
    PRIMARY KEY (route, dir, window_start)
);

-- Spark Batch output — hourly historical analytics
CREATE TABLE IF NOT EXISTS eta_analytics (
    route         VARCHAR(10)   NOT NULL,
    hour_of_day   INT           NOT NULL,  -- 0–23
    day_of_week   INT           NOT NULL,  -- 0=Monday, 6=Sunday
    avg_wait_sec  FLOAT,
    p95_wait_sec  FLOAT,
    computed_at   TIMESTAMPTZ   NOT NULL,
    PRIMARY KEY (route, hour_of_day, day_of_week, computed_at)
);
```

- [ ] **Step 2: Commit**

```bash
git add k8s/postgres/init.sql
git commit -m "feat: PostgreSQL schema for ETA pipeline"
```

---

## Task 6: Spark Streaming Job

**Files:**
- Create: `spark/streaming_job.py`
- Create: `tests/test_streaming_job.py`

Key logic: for each Kafka message, compute `wait_sec = eta - data_timestamp`. Over a 1-minute window per route+dir, compute `avg_wait_sec`. Set `delay_flag = avg_wait_sec > 600`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_streaming_job.py`:

```python
import pytest
from datetime import datetime, timezone, timedelta
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'spark'))
from streaming_job import compute_wait_seconds, compute_delay_flag, parse_eta_record


def make_record(eta_offset_min=10, data_ts_offset_min=0):
    base = datetime(2026, 4, 22, 14, 0, 0, tzinfo=timezone.utc)
    eta = (base + timedelta(minutes=eta_offset_min)).isoformat()
    data_ts = (base + timedelta(minutes=data_ts_offset_min)).isoformat()
    return {
        "co": "KMB", "route": "1A", "dir": "O",
        "stop": "STOP_AAA", "eta_seq": 1,
        "eta": eta, "rmk_en": "", "data_timestamp": data_ts,
        "fetched_at": data_ts
    }


def test_compute_wait_seconds_returns_correct_value():
    record = make_record(eta_offset_min=10, data_ts_offset_min=0)
    wait = compute_wait_seconds(record["eta"], record["data_timestamp"])
    assert wait == pytest.approx(600.0)


def test_compute_wait_seconds_returns_none_for_null_eta():
    wait = compute_wait_seconds(None, "2026-04-22T14:00:00+00:00")
    assert wait is None


def test_compute_delay_flag_true_above_threshold():
    assert compute_delay_flag(601.0) is True


def test_compute_delay_flag_false_below_threshold():
    assert compute_delay_flag(599.0) is False


def test_compute_delay_flag_false_for_none():
    assert compute_delay_flag(None) is False


def test_parse_eta_record_returns_expected_keys():
    record = make_record()
    parsed = parse_eta_record(record)
    assert parsed["route"] == "1A"
    assert parsed["dir"] == "O"
    assert parsed["wait_sec"] == pytest.approx(600.0)
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pytest tests/test_streaming_job.py -v
```
Expected: `ModuleNotFoundError: No module named 'streaming_job'`

- [ ] **Step 3: Write `spark/streaming_job.py`**

```python
import json
import os
from datetime import datetime
from dateutil import parser as dtparser
import psycopg2

# ── Pure transformation functions (unit-testable without Spark) ──────────────

def compute_wait_seconds(eta_str: str, data_ts_str: str):
    """Return seconds between data_timestamp and eta. None if eta is null."""
    if not eta_str:
        return None
    try:
        eta = dtparser.parse(eta_str)
        data_ts = dtparser.parse(data_ts_str)
        return (eta - data_ts).total_seconds()
    except Exception:
        return None


def compute_delay_flag(avg_wait_sec) -> bool:
    """True if average wait exceeds 10 minutes."""
    if avg_wait_sec is None:
        return False
    return avg_wait_sec > 600


def parse_eta_record(record: dict) -> dict:
    wait = compute_wait_seconds(record.get("eta"), record.get("data_timestamp"))
    return {
        "co": record.get("co"),
        "route": record.get("route"),
        "dir": record.get("dir"),
        "stop": record.get("stop"),
        "eta_seq": record.get("eta_seq"),
        "eta": record.get("eta"),
        "rmk_en": record.get("rmk_en", ""),
        "data_timestamp": record.get("data_timestamp"),
        "fetched_at": record.get("fetched_at"),
        "wait_sec": wait,
    }


# ── Spark entry point ────────────────────────────────────────────────────────

def get_db_conn():
    return psycopg2.connect(
        host=os.environ.get("POSTGRES_HOST", "postgres"),
        port=int(os.environ.get("POSTGRES_PORT", "5432")),
        dbname=os.environ.get("POSTGRES_DB", "hkbus"),
        user=os.environ.get("POSTGRES_USER", "postgres"),
        password=os.environ.get("POSTGRES_PASSWORD", "postgres"),
    )


def write_raw(conn, record: dict):
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO eta_raw (co, route, dir, stop, eta_seq, eta, rmk_en, data_timestamp, fetched_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (record["co"], record["route"], record["dir"], record["stop"],
             record["eta_seq"], record["eta"], record["rmk_en"],
             record["data_timestamp"], record["fetched_at"])
        )
    conn.commit()


def write_realtime(conn, route: str, dir_: str, window_start: str,
                   avg_wait: float, delay_flag: bool, count: int):
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO eta_realtime (route, dir, window_start, avg_wait_sec, delay_flag, sample_count)
               VALUES (%s,%s,%s,%s,%s,%s)
               ON CONFLICT (route, dir, window_start) DO UPDATE
               SET avg_wait_sec=EXCLUDED.avg_wait_sec,
                   delay_flag=EXCLUDED.delay_flag,
                   sample_count=EXCLUDED.sample_count""",
            (route, dir_, window_start, avg_wait, delay_flag, count)
        )
    conn.commit()


def main():
    from pyspark.sql import SparkSession
    from pyspark.sql.functions import (
        from_json, col, window, avg, count as spark_count,
        udf, to_timestamp
    )
    from pyspark.sql.types import (
        StructType, StructField, StringType, IntegerType, DoubleType, BooleanType
    )

    KAFKA_BROKER = os.environ.get("KAFKA_BROKER", "kafka:9092")
    KAFKA_TOPIC = os.environ.get("KAFKA_TOPIC", "kmb-eta-raw")

    spark = SparkSession.builder \
        .appName("KMBStreamingJob") \
        .config("spark.jars.packages",
                "org.apache.spark:spark-sql-kafka-0-10_2.12:3.5.0,"
                "org.postgresql:postgresql:42.7.1") \
        .getOrCreate()
    spark.sparkContext.setLogLevel("WARN")

    schema = StructType([
        StructField("co", StringType()),
        StructField("route", StringType()),
        StructField("dir", StringType()),
        StructField("service_type", StringType()),
        StructField("seq", IntegerType()),
        StructField("stop", StringType()),
        StructField("dest_en", StringType()),
        StructField("eta_seq", IntegerType()),
        StructField("eta", StringType()),
        StructField("rmk_en", StringType()),
        StructField("data_timestamp", StringType()),
        StructField("fetched_at", StringType()),
    ])

    wait_udf = udf(compute_wait_seconds, DoubleType())

    raw_df = spark.readStream \
        .format("kafka") \
        .option("kafka.bootstrap.servers", KAFKA_BROKER) \
        .option("subscribe", KAFKA_TOPIC) \
        .option("startingOffsets", "latest") \
        .load() \
        .select(from_json(col("value").cast("string"), schema).alias("d")) \
        .select("d.*") \
        .withColumn("wait_sec", wait_udf(col("eta"), col("data_timestamp"))) \
        .withColumn("event_time", to_timestamp(col("data_timestamp")))

    agg_df = raw_df \
        .withWatermark("event_time", "2 minutes") \
        .groupBy(
            window(col("event_time"), "1 minute"),
            col("route"), col("dir")
        ) \
        .agg(
            avg("wait_sec").alias("avg_wait_sec"),
            spark_count("*").alias("sample_count")
        )

    JDBC_URL = f"jdbc:postgresql://{os.environ.get('POSTGRES_HOST','postgres')}:{os.environ.get('POSTGRES_PORT','5432')}/{os.environ.get('POSTGRES_DB','hkbus')}"
    JDBC_PROPS = {
        "user": os.environ.get("POSTGRES_USER", "postgres"),
        "password": os.environ.get("POSTGRES_PASSWORD", "postgres"),
        "driver": "org.postgresql.Driver",
    }

    def write_batch(batch_df, batch_id):
        rows = batch_df.collect()
        conn = get_db_conn()
        for row in rows:
            avg_w = row["avg_wait_sec"]
            flag = compute_delay_flag(avg_w)
            write_realtime(conn, row["route"], row["dir"],
                           str(row["window"]["start"]), avg_w, flag, row["sample_count"])
        conn.close()

    query = agg_df.writeStream \
        .foreachBatch(write_batch) \
        .outputMode("update") \
        .trigger(processingTime="30 seconds") \
        .start()

    query.awaitTermination()


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Install python-dateutil for tests**

```bash
pip install python-dateutil
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pytest tests/test_streaming_job.py -v
```
Expected: all 6 tests PASS

- [ ] **Step 6: Commit**

```bash
git add spark/streaming_job.py tests/test_streaming_job.py
git commit -m "feat: Spark Streaming job with transformation unit tests"
```

---

## Task 7: Spark Batch Job

**Files:**
- Create: `spark/batch_job.py`
- Create: `tests/test_batch_job.py`

Reads `eta_raw` for the past 7 days, groups by route + hour_of_day + day_of_week, computes avg and p95 wait, writes to `eta_analytics`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_batch_job.py`:

```python
import pytest
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'spark'))
from batch_job import compute_p95, build_analytics_row


def test_compute_p95_correct():
    values = list(range(1, 101))  # 1..100
    assert compute_p95(values) == pytest.approx(95.05, rel=0.01)


def test_compute_p95_single_value():
    assert compute_p95([300.0]) == pytest.approx(300.0)


def test_compute_p95_empty_returns_none():
    assert compute_p95([]) is None


def test_build_analytics_row_structure():
    row = build_analytics_row("1A", 8, 1, [120.0, 180.0, 300.0])
    assert row["route"] == "1A"
    assert row["hour_of_day"] == 8
    assert row["day_of_week"] == 1
    assert row["avg_wait_sec"] == pytest.approx(200.0)
    assert "p95_wait_sec" in row
    assert "computed_at" in row
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pytest tests/test_batch_job.py -v
```
Expected: `ModuleNotFoundError: No module named 'batch_job'`

- [ ] **Step 3: Write `spark/batch_job.py`**

```python
import os
import statistics
from datetime import datetime, timezone


# ── Pure functions (unit-testable) ───────────────────────────────────────────

def compute_p95(values: list):
    if not values:
        return None
    sorted_vals = sorted(values)
    idx = int(len(sorted_vals) * 0.95)
    idx = min(idx, len(sorted_vals) - 1)
    return sorted_vals[idx]


def build_analytics_row(route: str, hour_of_day: int, day_of_week: int,
                        wait_values: list) -> dict:
    avg = statistics.mean(wait_values) if wait_values else None
    p95 = compute_p95(wait_values)
    return {
        "route": route,
        "hour_of_day": hour_of_day,
        "day_of_week": day_of_week,
        "avg_wait_sec": avg,
        "p95_wait_sec": p95,
        "computed_at": datetime.now(timezone.utc).isoformat(),
    }


# ── Spark entry point ────────────────────────────────────────────────────────

def main():
    from pyspark.sql import SparkSession
    from pyspark.sql.functions import (
        col, hour, dayofweek, expr, avg, percentile_approx, current_timestamp
    )

    POSTGRES_HOST = os.environ.get("POSTGRES_HOST", "postgres")
    POSTGRES_PORT = os.environ.get("POSTGRES_PORT", "5432")
    POSTGRES_DB = os.environ.get("POSTGRES_DB", "hkbus")
    POSTGRES_USER = os.environ.get("POSTGRES_USER", "postgres")
    POSTGRES_PASSWORD = os.environ.get("POSTGRES_PASSWORD", "postgres")
    JDBC_URL = f"jdbc:postgresql://{POSTGRES_HOST}:{POSTGRES_PORT}/{POSTGRES_DB}"
    JDBC_PROPS = {
        "user": POSTGRES_USER,
        "password": POSTGRES_PASSWORD,
        "driver": "org.postgresql.Driver",
    }

    spark = SparkSession.builder \
        .appName("KMBBatchJob") \
        .config("spark.jars.packages", "org.postgresql:postgresql:42.7.1") \
        .getOrCreate()
    spark.sparkContext.setLogLevel("WARN")

    raw_df = spark.read.jdbc(JDBC_URL, "eta_raw", properties=JDBC_PROPS) \
        .filter("fetched_at >= NOW() - INTERVAL '7 days'") \
        .filter("eta IS NOT NULL") \
        .withColumn("wait_sec",
            (col("eta").cast("double") - col("data_timestamp").cast("double"))) \
        .filter("wait_sec >= 0 AND wait_sec < 7200") \
        .withColumn("hour_of_day", hour(col("fetched_at"))) \
        .withColumn("day_of_week", dayofweek(col("fetched_at")) - 2)  # 0=Mon

    analytics_df = raw_df.groupBy("route", "hour_of_day", "day_of_week") \
        .agg(
            avg("wait_sec").alias("avg_wait_sec"),
            percentile_approx("wait_sec", 0.95).alias("p95_wait_sec"),
            current_timestamp().alias("computed_at")
        )

    analytics_df.write.jdbc(
        JDBC_URL, "eta_analytics", mode="append", properties=JDBC_PROPS
    )

    print(f"Batch job complete: {analytics_df.count()} rows written to eta_analytics")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pytest tests/test_batch_job.py -v
```
Expected: all 4 tests PASS

- [ ] **Step 5: Run full test suite**

```bash
pytest tests/ -v
```
Expected: all tests across all files PASS

- [ ] **Step 6: Commit**

```bash
git add spark/batch_job.py tests/test_batch_job.py
git commit -m "feat: Spark Batch job with unit tests"
```

---

> ## ─── CLUSTER BOUNDARY ───
> Tasks 8–14 require the other Mac with Docker Desktop + Kubernetes enabled.
> Push to GitHub first: `git push origin main`
> Then on the cluster machine: `git clone <repo-url> && cd hk-bus`

---

## Task 8: Kubernetes Namespace + Kafka Manifests

**Files:**
- Create: `k8s/namespace.yaml`
- Create: `k8s/kafka/zookeeper.yaml`
- Create: `k8s/kafka/kafka.yaml`

- [ ] **Step 1: Write `k8s/namespace.yaml`**

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: hk-bus
```

- [ ] **Step 2: Write `k8s/kafka/zookeeper.yaml`**

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: zookeeper
  namespace: hk-bus
spec:
  serviceName: zookeeper
  replicas: 1
  selector:
    matchLabels:
      app: zookeeper
  template:
    metadata:
      labels:
        app: zookeeper
    spec:
      containers:
        - name: zookeeper
          image: bitnami/zookeeper:3.8
          ports:
            - containerPort: 2181
          env:
            - name: ALLOW_ANONYMOUS_LOGIN
              value: "yes"
---
apiVersion: v1
kind: Service
metadata:
  name: zookeeper
  namespace: hk-bus
spec:
  selector:
    app: zookeeper
  ports:
    - port: 2181
      targetPort: 2181
```

- [ ] **Step 3: Write `k8s/kafka/kafka.yaml`**

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: kafka
  namespace: hk-bus
spec:
  serviceName: kafka
  replicas: 1
  selector:
    matchLabels:
      app: kafka
  template:
    metadata:
      labels:
        app: kafka
    spec:
      containers:
        - name: kafka
          image: bitnami/kafka:3.6
          ports:
            - containerPort: 9092
          env:
            - name: KAFKA_CFG_ZOOKEEPER_CONNECT
              value: "zookeeper:2181"
            - name: KAFKA_CFG_LISTENERS
              value: "PLAINTEXT://:9092"
            - name: KAFKA_CFG_ADVERTISED_LISTENERS
              value: "PLAINTEXT://kafka:9092"
            - name: ALLOW_PLAINTEXT_LISTENER
              value: "yes"
            - name: KAFKA_CFG_AUTO_CREATE_TOPICS_ENABLE
              value: "true"
---
apiVersion: v1
kind: Service
metadata:
  name: kafka
  namespace: hk-bus
spec:
  selector:
    app: kafka
  ports:
    - port: 9092
      targetPort: 9092
```

- [ ] **Step 4: Apply and verify**

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/kafka/
kubectl get pods -n hk-bus -w
```
Expected: `zookeeper-0` and `kafka-0` reach `Running` state.

- [ ] **Step 5: Commit**

```bash
git add k8s/namespace.yaml k8s/kafka/
git commit -m "feat: Kafka + ZooKeeper Kubernetes manifests"
```

---

## Task 9: PostgreSQL Kubernetes Manifest

**Files:**
- Create: `k8s/postgres/postgres.yaml`

- [ ] **Step 1: Write `k8s/postgres/postgres.yaml`**

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-pvc
  namespace: hk-bus
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 5Gi
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: hk-bus
spec:
  serviceName: postgres
  replicas: 1
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
        - name: postgres
          image: postgres:16-alpine
          ports:
            - containerPort: 5432
          env:
            - name: POSTGRES_PASSWORD
              value: "postgres"
            - name: POSTGRES_DB
              value: "hkbus"
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
            - name: init-sql
              mountPath: /docker-entrypoint-initdb.d
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: postgres-pvc
        - name: init-sql
          configMap:
            name: postgres-init
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: postgres-init
  namespace: hk-bus
data:
  init.sql: |
    CREATE TABLE IF NOT EXISTS eta_raw (
        id            SERIAL PRIMARY KEY,
        co            VARCHAR(10),
        route         VARCHAR(10)   NOT NULL,
        dir           CHAR(1)       NOT NULL,
        stop          VARCHAR(64)   NOT NULL,
        eta_seq       INT,
        eta           TIMESTAMPTZ,
        rmk_en        TEXT,
        data_timestamp TIMESTAMPTZ,
        fetched_at    TIMESTAMPTZ   NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eta_raw_route ON eta_raw (route, dir);
    CREATE INDEX IF NOT EXISTS idx_eta_raw_fetched ON eta_raw (fetched_at);
    CREATE TABLE IF NOT EXISTS eta_realtime (
        route         VARCHAR(10)   NOT NULL,
        dir           CHAR(1)       NOT NULL,
        window_start  TIMESTAMPTZ   NOT NULL,
        avg_wait_sec  FLOAT,
        delay_flag    BOOLEAN,
        sample_count  INT,
        PRIMARY KEY (route, dir, window_start)
    );
    CREATE TABLE IF NOT EXISTS eta_analytics (
        route         VARCHAR(10)   NOT NULL,
        hour_of_day   INT           NOT NULL,
        day_of_week   INT           NOT NULL,
        avg_wait_sec  FLOAT,
        p95_wait_sec  FLOAT,
        computed_at   TIMESTAMPTZ   NOT NULL,
        PRIMARY KEY (route, hour_of_day, day_of_week, computed_at)
    );
---
apiVersion: v1
kind: Service
metadata:
  name: postgres
  namespace: hk-bus
spec:
  selector:
    app: postgres
  ports:
    - port: 5432
      targetPort: 5432
```

- [ ] **Step 2: Apply and verify**

```bash
kubectl apply -f k8s/postgres/
kubectl get pods -n hk-bus -w
```
Expected: `postgres-0` reaches `Running` state.

- [ ] **Step 3: Verify schema was created**

```bash
kubectl exec -it -n hk-bus postgres-0 -- psql -U postgres -d hkbus -c "\dt"
```
Expected: tables `eta_raw`, `eta_realtime`, `eta_analytics` listed.

- [ ] **Step 4: Commit**

```bash
git add k8s/postgres/postgres.yaml
git commit -m "feat: PostgreSQL StatefulSet with schema init"
```

---

## Task 10: OpenFaaS Installation + Fetcher Function

**Files:**
- Create: `k8s/openfaas/kmb-fetcher-fn.yaml`

- [ ] **Step 1: Install OpenFaaS via Helm**

```bash
helm repo add openfaas https://openfaas.github.io/faas-netes/
helm repo update
kubectl create namespace openfaas
kubectl create namespace openfaas-fn
helm install openfaas openfaas/openfaas \
  --namespace openfaas \
  --set functionNamespace=openfaas-fn \
  --set generateBasicAuth=true \
  --set faasnetes.httpProbe=true
```

- [ ] **Step 2: Verify OpenFaaS gateway is running**

```bash
kubectl get pods -n openfaas
```
Expected: `gateway-*`, `nats-*`, `queue-worker-*` all `Running`.

- [ ] **Step 3: Build and push the fetcher image**

On the cluster machine, run from the repo root:
```bash
docker build -t kmb-fetcher:latest functions/kmb-fetcher/
# Load into Docker Desktop k8s (no registry needed for local):
docker tag kmb-fetcher:latest localhost:5000/kmb-fetcher:latest
```
Or use `imagePullPolicy: Never` and the local image directly.

- [ ] **Step 4: Write `k8s/openfaas/kmb-fetcher-fn.yaml`**

```yaml
apiVersion: openfaas.com/v1
kind: Function
metadata:
  name: kmb-fetcher
  namespace: openfaas-fn
spec:
  name: kmb-fetcher
  image: kmb-fetcher:latest
  imagePullPolicy: IfNotPresent
  environment:
    KAFKA_BROKER: "kafka.hk-bus.svc.cluster.local:9092"
    KAFKA_TOPIC: "kmb-eta-raw"
  labels:
    com.openfaas.scale.min: "0"
    com.openfaas.scale.max: "5"
    com.openfaas.scale.zero: "true"
    com.openfaas.scale.zero-duration: "2m"
```

- [ ] **Step 5: Install the cron connector for scheduled triggers**

```bash
helm install cron-connector openfaas/cron-connector \
  --namespace openfaas \
  --set schedule="*/30 * * * * *"
```

Add the cron annotation to the function:
```yaml
  annotations:
    topic: "cron-function"
    schedule: "* * * * *"
```
(Add these under `spec:` in `kmb-fetcher-fn.yaml`)

- [ ] **Step 6: Apply and verify**

```bash
kubectl apply -f k8s/openfaas/kmb-fetcher-fn.yaml
kubectl get functions -n openfaas-fn
```
Expected: `kmb-fetcher` listed with `READY` state.

- [ ] **Step 7: Verify scale-to-zero works**

```bash
# Watch pods — should show 0 replicas at rest
kubectl get pods -n openfaas-fn -w
# Manually invoke to trigger scale-up:
kubectl port-forward -n openfaas svc/gateway 8080:8080 &
curl -X POST http://localhost:8080/function/kmb-fetcher
# Watch pod appear then disappear after 2 minutes idle
```

- [ ] **Step 8: Commit**

```bash
git add k8s/openfaas/
git commit -m "feat: OpenFaaS kmb-fetcher function with cron trigger and scale-to-zero"
```

---

## Task 11: Spark Kubernetes Manifests

**Files:**
- Create: `k8s/spark/streaming-deployment.yaml`
- Create: `k8s/spark/batch-cronjob.yaml`
- Create: `k8s/spark/spark-image/Dockerfile`

- [ ] **Step 1: Create Spark Docker image for the cluster**

Create `k8s/spark/spark-image/Dockerfile`:

```dockerfile
FROM bitnami/spark:3.5

USER root
RUN pip install psycopg2-binary python-dateutil kafka-python

COPY streaming_job.py /opt/bitnami/spark/jobs/
COPY batch_job.py /opt/bitnami/spark/jobs/

USER 1001
```

Build on cluster machine:
```bash
cp spark/streaming_job.py k8s/spark/spark-image/
cp spark/batch_job.py k8s/spark/spark-image/
docker build -t kmb-spark:latest k8s/spark/spark-image/
```

- [ ] **Step 2: Write `k8s/spark/streaming-deployment.yaml`**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: spark-streaming
  namespace: hk-bus
spec:
  replicas: 1
  selector:
    matchLabels:
      app: spark-streaming
  template:
    metadata:
      labels:
        app: spark-streaming
    spec:
      containers:
        - name: spark-streaming
          image: kmb-spark:latest
          imagePullPolicy: IfNotPresent
          command: ["/opt/bitnami/spark/bin/spark-submit"]
          args:
            - "--master=local[2]"
            - "--packages=org.apache.spark:spark-sql-kafka-0-10_2.12:3.5.0,org.postgresql:postgresql:42.7.1"
            - "/opt/bitnami/spark/jobs/streaming_job.py"
          env:
            - name: KAFKA_BROKER
              value: "kafka.hk-bus.svc.cluster.local:9092"
            - name: KAFKA_TOPIC
              value: "kmb-eta-raw"
            - name: POSTGRES_HOST
              value: "postgres.hk-bus.svc.cluster.local"
            - name: POSTGRES_DB
              value: "hkbus"
            - name: POSTGRES_USER
              value: "postgres"
            - name: POSTGRES_PASSWORD
              value: "postgres"
```

- [ ] **Step 3: Write `k8s/spark/batch-cronjob.yaml`**

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: spark-batch
  namespace: hk-bus
spec:
  schedule: "0 * * * *"   # every hour
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: spark-batch
              image: kmb-spark:latest
              imagePullPolicy: IfNotPresent
              command: ["/opt/bitnami/spark/bin/spark-submit"]
              args:
                - "--master=local[2]"
                - "--packages=org.postgresql:postgresql:42.7.1"
                - "/opt/bitnami/spark/jobs/batch_job.py"
              env:
                - name: POSTGRES_HOST
                  value: "postgres.hk-bus.svc.cluster.local"
                - name: POSTGRES_DB
                  value: "hkbus"
                - name: POSTGRES_USER
                  value: "postgres"
                - name: POSTGRES_PASSWORD
                  value: "postgres"
```

- [ ] **Step 4: Apply and verify**

```bash
kubectl apply -f k8s/spark/
kubectl get pods -n hk-bus
kubectl logs -n hk-bus -l app=spark-streaming -f
```
Expected: Spark Streaming pod running, logs show "Streaming query started".

- [ ] **Step 5: Commit**

```bash
git add k8s/spark/
git commit -m "feat: Spark Streaming Deployment and Batch CronJob manifests"
```

---

## Task 12: Prometheus + Grafana Installation

- [ ] **Step 1: Install kube-prometheus-stack**

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
helm install monitoring prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  --set grafana.enabled=false \
  --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false
```

- [ ] **Step 2: Write `k8s/grafana/grafana.yaml`**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: grafana
  namespace: hk-bus
spec:
  replicas: 1
  selector:
    matchLabels:
      app: grafana
  template:
    metadata:
      labels:
        app: grafana
    spec:
      containers:
        - name: grafana
          image: grafana/grafana:10.4.0
          ports:
            - containerPort: 3000
          env:
            - name: GF_SECURITY_ADMIN_PASSWORD
              value: "admin"
          volumeMounts:
            - name: dashboards
              mountPath: /etc/grafana/provisioning/dashboards
            - name: datasources
              mountPath: /etc/grafana/provisioning/datasources
      volumes:
        - name: dashboards
          configMap:
            name: grafana-dashboards
        - name: datasources
          configMap:
            name: grafana-datasources
---
apiVersion: v1
kind: Service
metadata:
  name: grafana
  namespace: hk-bus
spec:
  type: NodePort
  selector:
    app: grafana
  ports:
    - port: 3000
      targetPort: 3000
      nodePort: 30300
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-datasources
  namespace: hk-bus
data:
  datasources.yaml: |
    apiVersion: 1
    datasources:
      - name: PostgreSQL
        type: postgres
        url: postgres.hk-bus.svc.cluster.local:5432
        database: hkbus
        user: postgres
        secureJsonData:
          password: postgres
        jsonData:
          sslmode: disable
          postgresVersion: 1600
      - name: Prometheus
        type: prometheus
        url: http://monitoring-kube-prometheus-prometheus.monitoring.svc.cluster.local:9090
```

- [ ] **Step 3: Apply and verify Grafana**

```bash
kubectl apply -f k8s/grafana/grafana.yaml
kubectl get pods -n hk-bus -l app=grafana
```
Expected: `grafana-*` pod `Running`. Access at `http://localhost:30300` (admin/admin).

- [ ] **Step 4: Commit**

```bash
git add k8s/grafana/
git commit -m "feat: Grafana deployment with PostgreSQL + Prometheus datasources"
```

---

## Task 13: Grafana Dashboard JSON

**Files:**
- Create: `grafana/dashboards/data-dashboard.json`
- Create: `grafana/dashboards/analytics-dashboard.json`
- Create: `grafana/dashboards/infra-dashboard.json`

- [ ] **Step 1: Create `grafana/dashboards/data-dashboard.json`**

```json
{
  "title": "KMB Bus Data Dashboard",
  "refresh": "5s",
  "panels": [
    {
      "title": "Average Wait Time by Route (Current Window)",
      "type": "barchart",
      "targets": [{
        "datasource": "PostgreSQL",
        "rawSql": "SELECT route || ' ' || dir AS route, avg_wait_sec FROM eta_realtime WHERE window_start = (SELECT MAX(window_start) FROM eta_realtime) ORDER BY avg_wait_sec DESC",
        "format": "table"
      }]
    },
    {
      "title": "Delayed Routes Right Now",
      "type": "table",
      "options": { "cellHeight": "sm" },
      "fieldConfig": {
        "overrides": [{
          "matcher": { "id": "byName", "options": "delay_flag" },
          "properties": [{ "id": "color", "value": { "fixedColor": "red", "mode": "fixed" }}]
        }]
      },
      "targets": [{
        "datasource": "PostgreSQL",
        "rawSql": "SELECT route, dir, ROUND(avg_wait_sec::numeric,0) AS wait_sec, sample_count FROM eta_realtime WHERE delay_flag = true AND window_start >= NOW() - INTERVAL '2 minutes' ORDER BY avg_wait_sec DESC",
        "format": "table"
      }]
    },
    {
      "title": "Wait Time Trend (Last 30 min)",
      "type": "timeseries",
      "targets": [{
        "datasource": "PostgreSQL",
        "rawSql": "SELECT window_start AS time, route, avg_wait_sec FROM eta_realtime WHERE window_start >= NOW() - INTERVAL '30 minutes' ORDER BY window_start",
        "format": "time_series"
      }]
    }
  ]
}
```

- [ ] **Step 2: Create `grafana/dashboards/analytics-dashboard.json`**

```json
{
  "title": "KMB Analytics Dashboard",
  "refresh": "5m",
  "panels": [
    {
      "title": "Average Wait by Hour of Day (Heatmap)",
      "type": "heatmap",
      "targets": [{
        "datasource": "PostgreSQL",
        "rawSql": "SELECT hour_of_day, route, AVG(avg_wait_sec) AS avg_wait FROM eta_analytics GROUP BY hour_of_day, route ORDER BY hour_of_day",
        "format": "table"
      }]
    },
    {
      "title": "Route Ranking by Average Delay",
      "type": "table",
      "targets": [{
        "datasource": "PostgreSQL",
        "rawSql": "SELECT route, ROUND(AVG(avg_wait_sec)::numeric,1) AS avg_wait_sec, ROUND(AVG(p95_wait_sec)::numeric,1) AS p95_wait_sec FROM eta_analytics GROUP BY route ORDER BY avg_wait_sec DESC LIMIT 20",
        "format": "table"
      }]
    },
    {
      "title": "P95 Wait Trend (7 days)",
      "type": "timeseries",
      "targets": [{
        "datasource": "PostgreSQL",
        "rawSql": "SELECT computed_at AS time, route, p95_wait_sec FROM eta_analytics WHERE computed_at >= NOW() - INTERVAL '7 days' ORDER BY computed_at",
        "format": "time_series"
      }]
    }
  ]
}
```

- [ ] **Step 3: Create `grafana/dashboards/infra-dashboard.json`**

```json
{
  "title": "Infrastructure Dashboard (Serverless Demo)",
  "refresh": "5s",
  "panels": [
    {
      "title": "kmb-fetcher Pod Count (Scale to Zero)",
      "type": "timeseries",
      "description": "Watch this go 0→1→0 every 30 seconds — this is serverless autoscaling",
      "targets": [{
        "datasource": "Prometheus",
        "expr": "kube_deployment_status_replicas_available{namespace='openfaas-fn', deployment=~'kmb-fetcher.*'}",
        "legendFormat": "kmb-fetcher replicas"
      }]
    },
    {
      "title": "Kafka Messages/sec (kmb-eta-raw)",
      "type": "timeseries",
      "targets": [{
        "datasource": "Prometheus",
        "expr": "rate(kafka_server_brokertopicmetrics_messagesin_total{topic='kmb-eta-raw'}[1m])",
        "legendFormat": "messages/sec"
      }]
    },
    {
      "title": "Pod CPU Usage (hk-bus namespace)",
      "type": "timeseries",
      "targets": [{
        "datasource": "Prometheus",
        "expr": "sum(rate(container_cpu_usage_seconds_total{namespace='hk-bus'}[2m])) by (pod)",
        "legendFormat": "{{ pod }}"
      }]
    }
  ]
}
```

- [ ] **Step 4: Apply dashboards via ConfigMap**

```bash
kubectl create configmap grafana-dashboards \
  --from-file=grafana/dashboards/ \
  -n hk-bus --dry-run=client -o yaml | kubectl apply -f -
kubectl rollout restart deployment/grafana -n hk-bus
```

- [ ] **Step 5: Verify all three dashboards appear in Grafana at http://localhost:30300**

- [ ] **Step 6: Commit**

```bash
git add grafana/dashboards/
git commit -m "feat: Grafana dashboard JSON for data, analytics, and infra views"
```

---

## Task 14: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`**

```markdown
# HK Bus Tracking System

Serverless real-time Hong Kong bus ETA tracking system — a cloud computing course project
demonstrating open-source replacements for AWS serverless components, deployed on Kubernetes.

## Group Members

| Name | Student ID | Email |
|------|-----------|-------|
| (your name) | (your ID) | (your email) |

## Architecture

```
KMB API → OpenFaaS (kmb-fetcher, 30s cron) → Kafka → Spark Streaming → PostgreSQL → Grafana
                                                              ↑
                                                       Spark Batch (hourly CronJob)
```

| Component | AWS Equivalent |
|-----------|---------------|
| OpenFaaS  | Lambda |
| Kafka     | Kinesis |
| Spark Streaming | EMR (streaming) |
| Spark Batch | EMR (batch) |
| PostgreSQL | DynamoDB |
| Grafana | QuickSight |

## Prerequisites (cluster machine)

- macOS with Docker Desktop installed
- Kubernetes enabled in Docker Desktop Settings → Kubernetes → Enable Kubernetes
- `kubectl`, `helm` installed (`brew install kubectl helm`)
- Python 3.11+ (`brew install python`)

## Setup

### 1. Install OpenFaaS
```bash
helm repo add openfaas https://openfaas.github.io/faas-netes/
kubectl create namespace openfaas && kubectl create namespace openfaas-fn
helm install openfaas openfaas/openfaas -n openfaas \
  --set functionNamespace=openfaas-fn --set generateBasicAuth=true
```

### 2. Install Prometheus (for infra dashboard)
```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install monitoring prometheus-community/kube-prometheus-stack \
  -n monitoring --create-namespace --set grafana.enabled=false
```

### 3. Build Docker images
```bash
docker build -t kmb-fetcher:latest functions/kmb-fetcher/
cp spark/*.py k8s/spark/spark-image/
docker build -t kmb-spark:latest k8s/spark/spark-image/
```

### 4. Deploy everything
```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/kafka/
kubectl apply -f k8s/postgres/
kubectl apply -f k8s/spark/
kubectl apply -f k8s/grafana/grafana.yaml
kubectl apply -f k8s/openfaas/kmb-fetcher-fn.yaml
```

### 5. Access Grafana
Open http://localhost:30300 — login: admin / admin

## Demo: Serverless Autoscaling

Watch the Infrastructure Dashboard → "kmb-fetcher Pod Count" panel.
Every 30 seconds the pod count goes from 0 → 1 → 0, proving scale-to-zero serverless behaviour.

To trigger manually:
```bash
kubectl port-forward -n openfaas svc/gateway 8080:8080
curl -X POST http://localhost:8080/function/kmb-fetcher
kubectl get pods -n openfaas-fn -w
```

## Running Tests Locally (no Docker needed)

```bash
pip install -r requirements-dev.txt python-dateutil
pytest tests/ -v
```

## Member Contributions

| Member | Contribution |
|--------|-------------|
| (your name) | Full system design and implementation |
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README with setup instructions and architecture overview"
git push origin main
```

---

## Verification Checklist

**Local (no Docker):**
- [ ] `pytest tests/ -v` — all tests pass
- [ ] `python scripts/bootstrap_stops.py` — generates `stops_config.json` with stop IDs

**On cluster machine:**
- [ ] Grafana Data Dashboard at http://localhost:30300 shows live updating route wait times
- [ ] Delayed routes appear with red highlight in the table
- [ ] Analytics Dashboard shows heatmap after 1+ hour of data collection
- [ ] Infrastructure Dashboard shows `kmb-fetcher` pod count oscillating 0→1→0 every 30s
- [ ] `kubectl exec -it -n hk-bus postgres-0 -- psql -U postgres -d hkbus -c "SELECT COUNT(*) FROM eta_raw"` shows growing count
