# HK Bus Tracking System

Real-time Hong Kong KMB bus ETA tracking pipeline built on open-source equivalents of AWS serverless services, deployed on Kubernetes.

---

## Group Members

| Name | Student ID | Email |
|------|------------|-------|
| (your name) | (your student ID) | (your email) |
| (teammate name) | (teammate student ID) | (teammate email) |

---

## Architecture

```
KMB Public API
      |
      v
OpenFaaS Function: kmb-fetcher          (AWS Lambda equivalent)
  - Triggered by cron every minute
  - Fetches ETA for 757 stops across 22 routes
  - Publishes JSON records to Kafka
      |
      v
Apache Kafka: kmb-eta-raw topic         (AWS Kinesis equivalent)
      |
      +-----------------------------+
      |                             |
      v                             v
Spark Streaming Job             Spark Batch Job (hourly CronJob)
  - 1-min tumbling windows        - Reads eta_raw (last 7 days)
  - Computes avg wait/route        - Computes avg + P95 wait
  - Writes eta_realtime            - Writes eta_analytics
  - Writes eta_raw (archive)           |
      |                             |
      +-----------------------------+
                   |
                   v
             PostgreSQL                 (AWS DynamoDB equivalent)
             |- eta_raw
             |- eta_realtime
             |- eta_analytics
                   |
                   v
               Grafana                  (AWS QuickSight equivalent)
               |- Data Dashboard        (live route wait times)
               |- Analytics Dashboard  (historical trends)
               |- Infra Dashboard      (scale-to-zero demo)
```

### AWS Equivalent Mapping

| This Project | AWS Equivalent |
|-------------|---------------|
| OpenFaaS | Lambda |
| Kafka | Kinesis |
| Spark Streaming | EMR (streaming) |
| Spark Batch | EMR (batch) |
| PostgreSQL | DynamoDB |
| Grafana | QuickSight |

---

## Prerequisites (on the cluster machine)

- macOS with Docker Desktop installed
- Kubernetes enabled in Docker Desktop (Settings → Kubernetes → Enable)
- `kubectl` configured to use `docker-desktop` context
- `helm` installed (`brew install helm`)
- Internet access (to pull images and call KMB API)

---

## Setup Instructions

### 1. Clone the Repository

```bash
git clone https://github.com/Anson-1/hk-bus.git
cd hk-bus
```

### 2. Verify Kubernetes Context

```bash
kubectl config use-context docker-desktop
kubectl get nodes   # should show 1 node Ready
```

### 3. Install OpenFaaS

```bash
helm repo add openfaas https://openfaas.github.io/faas-netes/
helm repo update
helm install openfaas openfaas/openfaas \
  --namespace openfaas \
  --create-namespace \
  --set functionNamespace=openfaas-fn \
  --set generateBasicAuth=true \
  --set operator.create=true \
  --set clusterRole=true
```

Wait for OpenFaaS gateway to be ready:

```bash
kubectl rollout status deploy/gateway -n openfaas
```

### 4. Install kube-prometheus-stack (for Infra Dashboard metrics)

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
helm install monitoring prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  --set grafana.enabled=false \
  --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false
```

### 5. Build the Spark Docker Image

```bash
cd k8s/spark/spark-image
docker build -t kmb-spark:latest .
cd ../../..
```

### 6. Build and Deploy the kmb-fetcher Function

```bash
cd functions/kmb-fetcher
docker build -t kmb-fetcher:latest .
cd ../..
```

### 7. Deploy All Kubernetes Resources

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/kafka/
kubectl apply -f k8s/postgres/

# Wait for Kafka and PostgreSQL to be ready

kubectl wait --for=condition=ready pod -l app=postgres -n hk-bus --timeout=60s

kubectl apply -f k8s/spark/
kubectl apply -f k8s/openfaas/
kubectl apply -f k8s/grafana/
```

### 8. Load Grafana Dashboards

```bash
kubectl create configmap grafana-dashboards \
  --from-file=grafana/dashboards/data-dashboard.json \
  --from-file=grafana/dashboards/analytics-dashboard.json \
  --from-file=grafana/dashboards/infra-dashboard.json \
  --namespace hk-bus \
  --dry-run=client -o yaml | kubectl apply -f -
```

Restart Grafana to pick up the dashboards:

```bash
kubectl rollout restart deployment/grafana -n hk-bus
```

### 9. Access Grafana

Open in browser: **http://localhost:30300**

- Username: `admin`
- Password: `admin`

Navigate to **Dashboards → HK Bus** to see all three dashboards.

---

## Demo: Watching Scale-to-Zero Autoscaling

The key demo moment is watching the `kmb-fetcher` OpenFaaS function scale from 0 replicas to 1 and back to 0 every minute.

### Step 1: Open the Infrastructure Dashboard

Go to **http://localhost:30300** → Dashboards → HK Bus → Infrastructure Dashboard.

The top-left panel "kmb-fetcher Pod Count — Scale to Zero" shows a live time series.

### Step 2: Watch in the Terminal (optional, parallel view)

```bash
kubectl get pods -n openfaas-fn -w
```

You will see:
```
NAME                          READY   STATUS    RESTARTS   AGE
kmb-fetcher-xxx-yyy           0/1     Pending   0          0s
kmb-fetcher-xxx-yyy           1/1     Running   0          3s
kmb-fetcher-xxx-yyy           1/1     Terminating   0      45s
```

### Step 3: Verify Kafka is Receiving Messages

```bash
kubectl exec -it kafka-0 -n hk-bus -- \
  /opt/bitnami/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 \
  --topic kmb-eta-raw \
  --from-beginning \
  --max-messages 5
```

### Step 4: Verify PostgreSQL is Being Populated

```bash
kubectl exec -it postgres-0 -n hk-bus -- \
  psql -U postgres -d hkbus -c \
  "SELECT route, dir, avg_wait_sec, delay_flag FROM eta_realtime ORDER BY window_start DESC LIMIT 10;"
```

---

## Local Development & Testing

No Docker required — all Python code is unit-tested locally.

### Setup

```bash
conda create -n hk-bus python=3.11
conda activate hk-bus
pip install -r requirements-dev.txt
pip install -r functions/kmb-fetcher/requirements.txt
pip install psycopg2-binary python-dateutil
```

### Run All Tests

```bash
pytest tests/ -v
```

Expected output: **18 tests passing**

```
tests/test_bootstrap.py::test_fetch_stops_for_route_returns_stop_ids PASSED
tests/test_bootstrap.py::test_fetch_stops_for_route_handles_empty_data PASSED
tests/test_bootstrap.py::test_build_stops_config_deduplicates PASSED
tests/test_handler.py::test_fetch_stop_eta_returns_records PASSED
tests/test_handler.py::test_filter_records_keeps_target_routes PASSED
tests/test_handler.py::test_fetch_stop_eta_adds_fetched_at PASSED
tests/test_handler.py::test_build_kafka_message_structure PASSED
tests/test_handler.py::test_handle_publishes_filtered_records PASSED
tests/test_streaming_job.py::test_compute_wait_seconds_positive PASSED
tests/test_streaming_job.py::test_compute_wait_seconds_null_eta PASSED
tests/test_streaming_job.py::test_compute_delay_flag_true PASSED
tests/test_streaming_job.py::test_compute_delay_flag_false PASSED
tests/test_streaming_job.py::test_compute_delay_flag_none PASSED
tests/test_streaming_job.py::test_parse_eta_record_keys PASSED
tests/test_batch_job.py::test_compute_p95_correct PASSED
tests/test_batch_job.py::test_compute_p95_single_value PASSED
tests/test_batch_job.py::test_compute_p95_empty PASSED
tests/test_batch_job.py::test_build_analytics_row_structure PASSED
```

### Refresh the Stop List (one-time, optional)

```bash
conda activate hk-bus
python scripts/bootstrap_stops.py
```

This regenerates `functions/kmb-fetcher/stops_config.json` with the latest stop IDs for the 22 target routes.

---

## Target Routes

The system monitors 22 high-traffic KMB routes:

`1`, `1A`, `2`, `3C`, `5`, `6`, `6C`, `9`, `11`, `12`, `13D`, `15`, `26`, `40`, `42C`, `68X`, `74B`, `91M`, `91P`, `98D`, `270`, `N8`

---

## Project Structure

```
hk-bus/
├── functions/
│   └── kmb-fetcher/
│       ├── handler.py          # OpenFaaS function: fetch ETAs, publish to Kafka
│       ├── requirements.txt
│       ├── stops_config.json   # 757 stop IDs for 22 routes (committed)
│       └── Dockerfile
├── k8s/
│   ├── namespace.yaml
│   ├── kafka/
│   │   ├── zookeeper.yaml
│   │   └── kafka.yaml
│   ├── postgres/
│   │   ├── postgres.yaml       # Includes init.sql schema as ConfigMap
│   │   └── init.sql
│   ├── spark/
│   │   ├── spark-image/
│   │   │   ├── Dockerfile
│   │   │   ├── streaming_job.py
│   │   │   └── batch_job.py
│   │   ├── streaming-deployment.yaml
│   │   └── batch-cronjob.yaml
│   ├── grafana/
│   │   └── grafana.yaml
│   └── openfaas/
│       └── kmb-fetcher-fn.yaml
├── grafana/
│   └── dashboards/
│       ├── data-dashboard.json
│       ├── analytics-dashboard.json
│       └── infra-dashboard.json
├── scripts/
│   └── bootstrap_stops.py
├── tests/
│   ├── test_bootstrap.py
│   ├── test_handler.py
│   ├── test_streaming_job.py
│   └── test_batch_job.py
├── requirements-dev.txt
└── README.md
```
