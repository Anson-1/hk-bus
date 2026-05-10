# HK Transit Real-Time Tracker

A cloud-native transit tracking and analytics system for Hong Kong built as a **full reimplementation of an AWS serverless architecture** using open-source alternatives deployed on Kubernetes. It also includes a **PySpark batch analytics pipeline** over self-collected real-time data.

---

## Project Overview

This project covers two areas:

1. **AWS → Open-Source Mapping on Kubernetes** — Every AWS component is replaced with a self-hosted equivalent deployable to any Kubernetes cluster (kind locally, k3s on EC2).

2. **Spark Batch Analytics** — 14.6 million KMB ETA records self-collected from the HK government API are analysed with PySpark to find peak hours, per-route wait time distributions, and route reliability scores.

---

## AWS → Open-Source Mapping

| AWS Service | Open-Source Replacement | Role |
|---|---|---|
| **AWS Lambda** | **OpenFaaS** (Function CRDs + gateway) | `compute-analytics`, `spark-analytics` — scale-to-zero functions |
| **Amazon Kinesis** | **Redis Streams** | `kmb-eta-raw` stream between fetcher and alerter |
| **CloudWatch Events** | **Kubernetes CronJob** | Triggers functions on schedule |
| **RDS (PostgreSQL)** | **PostgreSQL 15** StatefulSet | All ETA records, analytics, alerts |
| **ElastiCache (Redis)** | **Redis 7** | Stream bus + API response caching |
| **API Gateway** | **Traefik** (k3s built-in) | Routes `/api/*` and frontend traffic |
| **ECS / Fargate** | **Kubernetes** (kind / k3s) | Orchestrates all services |
| **CloudWatch Dashboards** | **Grafana** | 7 dashboards — KMB, MTR, System Health, Spark Analytics, Accident Insights, Passenger Flow, Traffic (Lamppost) |
| **EMR / Glue (Spark)** | **PySpark in a K8s Job** | Batch analytics triggered daily by OpenFaaS function |

---

## Architecture

```
 KMB Gov API
      │
      ▼
 OpenFaaS: kmb-fetcher          (CronJob — every 1 min)
      │  XADD
      ▼
 Redis Stream: kmb-eta-raw
      │  XREADGROUP
      ▼
 delay-alerter                   (continuous consumer)
      │  INSERT
      ▼
 PostgreSQL: public.delay_alerts

 MTR Gov API ──► eta-fetcher ──► PostgreSQL: mtr.eta  (continuous)

 PostgreSQL: kmb.eta
      │
      ▼
 OpenFaaS: compute-analytics    (CronJob — every 1 hr)
      │  UPSERT
      ▼
 PostgreSQL: kmb.analytics

 OpenFaaS: spark-analytics      (CronJob — every day 2 AM HKT)
      │  submits K8s Job
      ▼
 PySpark Job (local[*])
      │  JDBC write
      ▼
 PostgreSQL: kmb.spark_analytics
             kmb.spark_peak_hours
             kmb.spark_route_reliability

 PostgreSQL ◄──── hk-bus-api (Express + Redis cache) ◄──── Web App (React)
 PostgreSQL ◄──── Grafana (direct SQL queries)

 HK TD Smart Lamppost XML Feed
      │
      ▼
 OpenFaaS: traffic-fetcher         (CronJob — every 2 min)
      │  INSERT + DELETE >24h
      ▼
 PostgreSQL: traffic_speed_volume

 HK Transport Dept Accident CSVs
      │
      ▼
 OpenFaaS: accident-fetcher        (CronJob — daily 2 AM HKT)
      │  TRUNCATE + INSERT
      ▼
 PostgreSQL: accident_summary

 IMMD Cross-Border Passenger CSV
      │
      ▼
 OpenFaaS: passenger-fetcher       (CronJob — daily 3 AM HKT)
      │  TRUNCATE + INSERT
      ▼
 PostgreSQL: passenger_daily_summary
```

---

## Spark Analytics (Part 2)

The PySpark job runs on 14.6 million KMB bus ETA records self-collected from the government API. It produces three result tables:

| Table | Rows | What it computes |
|---|---|---|
| `kmb.spark_analytics` | ~6,600 | Avg / P95 wait time per route per hour of day |
| `kmb.spark_peak_hours` | 17 | System-wide avg / P95 wait by hour of day |
| `kmb.spark_route_reliability` | ~700 | Per-route reliability score: `1 - stddev / (avg + 1)`, clamped ≥ 0 |

Key findings from the collected data:
- **Worst hour**: 3–5 AM — very long waits (avg 19–30 min) due to sparse overnight service
- **Best hours**: 8–13 — peak service, avg wait drops to ~10 min
- **Most reliable routes**: Airport/cross-harbour express routes (consistent intervals)
- **Least reliable**: Low-frequency rural routes with high variance

Results are visualised in the **Spark Analytics (Batch)** Grafana dashboard.

---

## Grafana Dashboards

Login at `http://localhost:3001` (local) or `http://<SERVER_IP>:30400` (EC2) — credentials: `admin` / `hkbus123`.

| Dashboard | What it shows |
|---|---|
| **KMB Delay Overview** | Total ETA rows, delay rate, delay events over time, top 20 worst routes, recent delay events |
| **MTR Overview** | Avg/P95 wait by line, wait trend over time, per-station hourly breakdown |
| **System Health** | KMB/MTR rows per minute, table sizes, last fetch timestamp, delay events per minute |
| **Spark Analytics (Batch)** | Avg/P95 wait by hour of day (bar chart), route reliability ranking, worst/best route-hour combinations |
| **HK Traffic Accident Insights** | Accidents by year/district/severity/road condition, fatal trend, hourly breakdown, wet vs dry day comparison |
| **HK Cross-Border Passenger Flow** | Total passengers since 2021, holiday surge multiplier, top control points, arrivals vs departures trend |
| **HK Real-Time Traffic (Lamppost)** | Live speed/volume from Smart Lamppost detectors, congestion by district, avg speed over time |

---

## Web App Features

- **Bus tab** — Search any KMB route, see real-time ETA at every stop
- **MTR tab** — Select any MTR line and station, see live train arrivals for both directions (auto-refreshes every 30 s)

---

## Quick Start (Local)

Full instructions are in **[DEPLOY.md](DEPLOY.md)**. Summary:

```bash
# 1. Create kind cluster
kind create cluster --name hk-bus

# 2. Pre-load images
docker pull ansonhui123/hk-bus-web-app:latest
# ... (see DEPLOY.md for full list)
kind load docker-image ansonhui123/hk-bus-web-app:latest --name hk-bus
# ...

# 3. Deploy core infrastructure
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/postgres/secret.yaml
kubectl apply -f k8s/postgres/postgres.yaml
kubectl apply -f k8s/redis.yaml
kubectl apply -f k8s/backend-api-deployment.yaml
kubectl apply -f k8s/monitoring/grafana.yaml

# 4. Install OpenFaaS and deploy functions
arkade install openfaas
kubectl rollout status -n openfaas deploy/gateway
kubectl -n openfaas set env deploy/gateway scale_zero=true

kubectl create namespace openfaas-fn --dry-run=client -o yaml | kubectl apply -f -
PG_PASS=$(kubectl get secret postgres-secret -n hk-bus -o jsonpath='{.data.password}' | base64 -d)
kubectl create secret generic postgres-secret -n openfaas-fn --from-literal=password=${PG_PASS} --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f k8s/spark/rbac.yaml
kubectl apply -f k8s/openfaas/functions-deployment.yaml

# 5. Port-forward
kubectl port-forward -n hk-bus svc/hk-bus-api 3000:3000 &
kubectl port-forward -n hk-bus svc/grafana-monitoring 3001:3000 &
kubectl port-forward -n openfaas svc/gateway 8888:8080 &
```

Web app: http://localhost:3000  
Grafana: http://localhost:3001 (admin / hkbus123)  
OpenFaaS UI: http://localhost:8888/ui/

---

## Project Structure

```
hk-bus/
├── k8s/
│   ├── namespace.yaml                     # hk-bus namespace
│   ├── ingress.yaml                       # Traefik ingress (replaces API Gateway)
│   ├── redis.yaml                         # Redis deployment (replaces ElastiCache)
│   ├── hpa.yaml                           # HPA for hk-bus-api (replaces Auto Scaling)
│   ├── postgres/
│   │   ├── postgres.yaml                  # StatefulSet + PVC + init schema
│   │   └── secret.yaml                    # DB password
│   ├── backend-api-deployment.yaml        # Web app Deployment + Service
│   ├── delay-alerter/
│   │   ├── Dockerfile
│   │   └── server.js                      # Redis Stream consumer → delay_alerts
│   ├── spark/
│   │   └── rbac.yaml                      # ServiceAccount + Role for Spark job submission
│   ├── monitoring/
│   │   └── grafana.yaml                   # Grafana Deployment + 4 dashboard ConfigMaps
│   └── openfaas/
│       └── functions-deployment.yaml      # kmb-fetcher (Deployment), compute-analytics +
│                                          # spark-analytics (OpenFaaS Function CRDs), CronJobs
├── functions/
│   ├── kmb-fetcher/                       # OpenFaaS fn: KMB API → Redis Stream (Python/Flask)
│   ├── compute-analytics/                 # OpenFaaS fn: kmb.eta → kmb.analytics (Node/Express)
│   ├── spark-analytics/                   # OpenFaaS fn: submits PySpark K8s Job (Python/Flask)
│   ├── traffic-fetcher/                   # OpenFaaS fn: Smart Lamppost XML → traffic_speed_volume (Python)
│   ├── accident-fetcher/                  # OpenFaaS fn: TD accident CSVs → accident_summary (Python)
│   └── passenger-fetcher/                 # OpenFaaS fn: IMMD passenger CSV → passenger_daily_summary (Python)
├── spark-jobs/
│   ├── Dockerfile                         # PySpark + PostgreSQL JDBC driver
│   └── kmb_analysis.py                    # PySpark job: 14.6M ETA records → 3 result tables
├── web-app/
│   ├── Dockerfile                         # Multi-stage: Vite build + Express serve
│   ├── backend/server.js                  # Express API — routes, stops, ETA, MTR, analytics
│   └── frontend/src/
│       ├── App.jsx
│       └── components/                    # BusStopView, RouteDetailsView, MtrView
├── monitoring/
│   └── grafana/dashboard-files/           # Dashboard JSON files (also embedded in grafana.yaml)
├── docker-compose.collector.yml           # Local dev stack for data collection + Spark testing
└── DEPLOY.md                              # Full deployment guide (kind + k3s)
```

---

## Docker Images

All images are on Docker Hub (multi-arch: linux/amd64 + linux/arm64):

| Image | Description |
|---|---|
| `ansonhui123/hk-bus-web-app` | React frontend + Express API |
| `ansonhui123/hk-bus-eta-fetcher` | Continuous KMB + MTR ETA collector → PostgreSQL |
| `ansonhui123/kmb-fetcher` | OpenFaaS function — KMB API → Redis Stream |
| `ansonhui123/compute-analytics` | OpenFaaS function — kmb.eta → kmb.analytics |
| `ansonhui123/spark-analytics` | OpenFaaS function — submits Spark K8s Job |
| `ansonhui123/hk-bus-spark` | PySpark job runner (14.6M record analysis) |
| `ansonhui123/delay-alerter` | Redis Stream consumer → delay_alerts |
| `ansonhui123/traffic-fetcher` | OpenFaaS function — Smart Lamppost XML → traffic_speed_volume (every 2 min) |
| `ansonhui123/accident-fetcher` | OpenFaaS function — TD accident CSVs → accident_summary (daily) |
| `ansonhui123/passenger-fetcher` | OpenFaaS function — IMMD passenger CSV → passenger_daily_summary (daily) |

---

## Database Schema

| Table | Schema | Description |
|---|---|---|
| `eta` | `kmb` | Raw KMB ETA records — route, stop, wait_minutes, remarks, fetched_at |
| `analytics` | `kmb` | Avg/P95 wait per route/hour — written by `compute-analytics` every hour |
| `spark_analytics` | `kmb` | Avg/P95/stddev per route/hour — written by PySpark weekly batch |
| `spark_peak_hours` | `kmb` | System-wide avg/P95 by hour of day |
| `spark_route_reliability` | `kmb` | Per-route reliability score (1 - stddev/(avg+1)) |
| `eta` | `mtr` | Raw MTR ETA records — line, station, direction, wait_minutes |
| `delay_alerts` | `public` | Delay events written by delay-alerter Redis Stream consumer |
| `accident_summary` | `public` | Aggregated accident counts by year/district/severity/road condition (daily refresh) |
| `weather_annual_stats` | `public` | Annual wet/dry day counts used for accident rate normalisation |
| `passenger_daily_summary` | `public` | Daily cross-border passenger counts by control point and direction (daily refresh) |
| `traffic_detector_locations` | `public` | Static Smart Lamppost detector locations — district, road, coordinates |
| `traffic_speed_volume` | `public` | Real-time speed/volume readings from Smart Lamppost detectors (24-hour rolling window) |

---

## Known Limitations

| Limitation | Detail |
|---|---|
| **OpenFaaS scale-to-zero requires Pro** | The community edition does not support the `openfaas.com/v1` `Function` CRD operator. Functions are deployed as standard Kubernetes Deployments with the `faas_function` label instead — they are always-on rather than truly scale-to-zero. |
| **KMB route coverage** | Both `kmb-fetcher` (OpenFaaS) and `eta-fetcher` dynamically load all routes from the KMB `/route` API on startup, covering the full KMB network. |
| **Single-replica services** | All deployments run 1 replica. PostgreSQL has no HA/replica configuration. This is acceptable for a demonstration cluster but not production. HPA is configured for `hk-bus-api` only. |
| **No HTTPS** | TLS termination is not configured in `ingress.yaml`. Suitable for local kind / internal EC2 testing only. |
| **Grafana credentials hardcoded** | Admin password (`hkbus123`) is set via environment variable in the Grafana deployment. Rotate before any public exposure. |
| **Data scope** | The 14.6 M record dataset used for Spark analytics was collected via a long-running EC2 collector, not the bundled kind cluster. A fresh kind deployment starts with an empty database; Spark results are pre-loaded from a dump in DEPLOY.md Step 6. |
