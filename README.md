# HK Transit Real-Time Tracker

A cloud-native transit tracking and analytics system for Hong Kong built as a **full reimplementation of an AWS architecture** using open-source alternatives deployed on Kubernetes. It also includes a **PySpark batch analytics pipeline** over self-collected real-time data.

---

## Table of Contents

- [Project Overview](#project-overview)
- [Quick Start (Local)](#quick-start-local)
- [AWS → Open-Source Mapping](#aws--open-source-mapping)
- [Architecture](#architecture)
- [Spark Analytics](#spark-analytics)
- [Grafana Dashboards](#grafana-dashboards)
- [Web App Features](#web-app-features)
- [Project Structure](#project-structure)
- [Docker Images](#docker-images)
- [Database Schema](#database-schema)
- [Known Limitations](#known-limitations)

---

## Project Overview

This project covers two areas:

1. **AWS → Open-Source Mapping on Kubernetes** — Every AWS component is replaced with a self-hosted equivalent deployable to any Kubernetes cluster (kind locally, k3s on EC2).

2. **Spark Batch Analytics** — 84 million raw KMB ETA records self-collected from the HK government API are analysed with PySpark (filtering to `eta_seq=1` next-bus predictions) to find peak hours, per-route wait time distributions, and route reliability scores.

---

## Quick Start (Local)

Full instructions are in **[DEPLOY.md](DEPLOY.md)**. Summary:

```bash
# 1. Create kind cluster
kind create cluster --name hk-bus

# 2. Pre-load images
docker pull heiheivan/hk-bus-web-app:latest
# ... (see DEPLOY.md for full list)
kind load docker-image heiheivan/hk-bus-web-app:latest --name hk-bus
# ...

# 3. Deploy core infrastructure
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/postgres/secret.yaml
kubectl apply -f k8s/postgres/postgres.yaml
kubectl apply -f k8s/redis.yaml
kubectl apply -f k8s/eta-fetcher/deployment.yaml
kubectl apply -f k8s/backend-api-deployment.yaml
kubectl apply -f k8s/monitoring/grafana.yaml

# 4. Install OpenFaaS and deploy functions
arkade install openfaas
kubectl rollout status -n openfaas deploy/gateway
kubectl -n openfaas set env deploy/gateway scale_zero=true

kubectl create namespace openfaas-fn --dry-run=client -o yaml | kubectl apply -f -
# Linux/Mac:
PG_PASS=$(kubectl get secret postgres-secret -n hk-bus -o jsonpath='{.data.password}' | base64 -d)
# Windows (PowerShell) — see DEPLOY.md Prerequisites for the full command
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

## AWS → Open-Source Mapping

| AWS Service | Open-Source Replacement | Role |
|---|---|---|
| **AWS Lambda** | **OpenFaaS + Kubernetes** (plain Deployments + CronJobs in `openfaas-fn`) | `kmb-fetcher` (every 1 min), `compute-analytics` (hourly), `spark-analytics` (daily 2 AM HKT), `traffic-fetcher` (every 2 min), `accident-fetcher` (daily 2 AM HKT), `passenger-fetcher` (daily 3 AM HKT) |
| **Amazon Kinesis** | **Redis Streams** | `kmb-eta-raw` stream pipes KMB ETA data from `kmb-fetcher` to `delay-alerter` |
| **Amazon RDS** | **PostgreSQL 15** StatefulSet | Stores all KMB & MTR ETA records, analytics results, delay alerts, traffic, accident, and passenger data |
| **Amazon ElastiCache** | **Redis 7** | API response caching + message stream bus |
| **AWS API Gateway** | **Traefik** (k3s built-in) | Routes `/api/*` traffic to backend and serves frontend |
| **Amazon ECS / Fargate** | **Kubernetes** (kind locally, k3s on EC2) | Orchestrates all services as pods/deployments |
| **CloudWatch Events** | **Kubernetes CronJob** | Schedules OpenFaaS functions (every 1 min, every 2 min, hourly, daily 2 AM HKT, daily 3 AM HKT) |
| **CloudWatch Dashboards** | **Grafana** | 7 dashboards — KMB Delay, MTR Overview, System Health, Spark Analytics, Traffic Accident Insights, Cross-Border Passenger Flow, Real-Time Traffic (Lamppost) |
| **Amazon EMR / AWS Glue** | **PySpark (K8s Job)** | Batch analysis of 24.8M filtered KMB ETA records (eta_seq=1) → route reliability & peak hours |
| **Amazon EC2** | **EC2 (kept)** | Always-on data collector running k3s + Docker stack |

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

 KMB Gov API ──► eta-fetcher ──► PostgreSQL: kmb.eta  (continuous, every 15s)
 MTR Gov API ──► eta-fetcher ──► PostgreSQL: mtr.eta  (continuous, every 30s)

 OpenFaaS: compute-analytics    (CronJob — every 1 hr, DB cleanup)
      │  DELETE old rows — rolling windows
      ▼
 PostgreSQL: kmb.eta (<1h), mtr.eta (<24h), public.delay_alerts (<7d)

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

## Spark Analytics

The PySpark job runs on 84 million raw KMB ETA records self-collected from the government API, filtering to `eta_seq=1` (next-bus predictions only). It produces three result tables:

| Table | Rows | What it computes |
|---|---|---|
| `kmb.spark_analytics` | ~6,600 | Avg / P95 wait time per route per hour of day |
| `kmb.spark_peak_hours` | 17 | System-wide avg / P95 wait by hour of day |
| `kmb.spark_route_reliability` | ~700 | Per-route reliability score: `1 - stddev / (avg + 1)`, clamped ≥ 0 |

Key findings from the collected data:
- **Worst hour**: 3–5 AM — very long waits (avg 19–30 min) due to sparse overnight service
- **Best hours**: 8–13 — peak service, avg wait drops to ~10 min
- **Most reliable routes**: Infrequent suburban routes (e.g. 214P, 234P, 271A) — long average waits (~35–38 min) but low relative variance, giving high consistency scores
- **Least reliable**: High-frequency urban routes (e.g. route 16, 58X, 31M) — short average waits (4–7 min) but stddev exceeds the mean, scoring zero reliability

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
│   │   ├── init.sql                       # Database schema initialisation
│   │   └── secret.yaml                    # DB password
│   ├── backend-api-deployment.yaml        # Web app Deployment + Service
│   ├── eta-fetcher/
│   │   ├── Dockerfile
│   │   ├── deployment.yaml                # Continuous KMB + MTR ETA collector
│   │   ├── server.js
│   │   └── generate-data-job.yaml         # One-off data generation job
│   ├── delay-alerter/
│   │   ├── Dockerfile
│   │   └── server.js                      # Redis Stream consumer → delay_alerts
│   ├── spark/
│   │   └── rbac.yaml                      # ServiceAccount + Role for Spark job submission
│   ├── monitoring/
│   │   └── grafana.yaml                   # Grafana Deployment + 7 dashboard ConfigMaps
│   └── openfaas/
│       └── functions-deployment.yaml      # All pipeline workers as plain Deployments + Services
│                                          # and CronJobs that trigger them on schedule
├── functions/
│   ├── stack.yaml                         # OpenFaaS stack definition
│   ├── kmb-fetcher/                       # OpenFaaS fn: KMB API → Redis Stream (Python/Flask)
│   ├── compute-analytics/                 # OpenFaaS fn: hourly DB cleanup — rolling windows for kmb.eta, mtr.eta, delay_alerts (Node/Express)
│   ├── spark-analytics/                   # OpenFaaS fn: submits PySpark K8s Job (Python/Flask)
│   ├── traffic-fetcher/                   # OpenFaaS fn: Smart Lamppost XML → traffic_speed_volume (Python)
│   ├── accident-fetcher/                  # OpenFaaS fn: TD accident CSVs → accident_summary (Python)
│   └── passenger-fetcher/                 # OpenFaaS fn: IMMD passenger CSV → passenger_daily_summary (Python)
├── spark-jobs/
│   ├── Dockerfile                         # PySpark + PostgreSQL JDBC driver
│   └── kmb_analysis.py                    # PySpark job: 84M raw ETA records (eta_seq=1) → 3 result tables
├── web-app/
│   ├── Dockerfile                         # Multi-stage: Vite build + Express serve
│   ├── backend/
│   │   ├── server.js                      # Express API — routes, stops, ETA, MTR, analytics
│   │   └── package.json
│   └── frontend/src/
│       ├── App.jsx
│       ├── main.jsx
│       └── components/                    # BusStopView, RouteDetailsView, MtrView, SearchBar, MapDisplay
├── monitoring/
│   ├── grafana/
│   │   ├── dashboard-files/               # Dashboard JSON files (also embedded in grafana.yaml)
│   │   ├── dashboards/providers.yaml      # Grafana dashboard provisioning config
│   │   └── datasources/datasources.yaml   # Grafana datasource provisioning config
│   └── prometheus/
│       └── prometheus.yml                 # Prometheus scrape config
├── scripts/
│   └── populate-stops.js                  # Seed KMB bus stops into PostgreSQL
├── init_schema.sql                        # Standalone DB schema (reference copy)
├── ec2-collector                          # Long-running EC2 data collector script
├── explore_apis.py                        # API exploration / prototyping script
├── run_local.sh                           # Local dev helper script
├── docker-compose.yml                     # Full local stack (all services)
├── docker-compose.collector.yml           # Local dev stack for data collection + Spark testing
├── .env.example                           # Environment variable template
└── DEPLOY.md                              # Full deployment guide (kind + k3s)
```

---

## Docker Images

All images are on Docker Hub (multi-arch: linux/amd64 + linux/arm64):

| Image | Description |
|---|---|
| `heiheivan/hk-bus-web-app` | React frontend + Express API |
| `heiheivan/hk-bus-eta-fetcher` | Continuous KMB + MTR ETA collector → PostgreSQL |
| `heiheivan/kmb-fetcher` | OpenFaaS function — KMB API → Redis Stream |
| `heiheivan/compute-analytics` | OpenFaaS function — hourly DB cleanup (rolling windows) |
| `heiheivan/spark-analytics` | OpenFaaS function — submits Spark K8s Job |
| `heiheivan/hk-bus-spark` | PySpark job runner (84M raw ETA records, eta_seq=1 analysis) |
| `heiheivan/delay-alerter` | Redis Stream consumer → delay_alerts |
| `heiheivan/traffic-fetcher` | OpenFaaS function — Smart Lamppost XML → traffic_speed_volume (every 2 min) |
| `heiheivan/accident-fetcher` | OpenFaaS function — TD accident CSVs → accident_summary (daily) |
| `heiheivan/passenger-fetcher` | OpenFaaS function — IMMD passenger CSV → passenger_daily_summary (daily) |

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
| **OpenFaaS scale-to-zero requires Pro** | Functions are deployed as always-on Kubernetes Deployments with OpenFaaS gateway routing, as scale-to-zero requires the commercial OpenFaaS Pro edition. |
| **Single-replica services** | All deployments run 1 replica. PostgreSQL has no HA/replica configuration. This is acceptable for a demonstration cluster but not production. An HPA definition for `hk-bus-api` exists in `k8s/hpa.yaml` but must be applied separately with `kubectl apply -f k8s/hpa.yaml`. |
| **No HTTPS** | TLS termination is not configured in `ingress.yaml`. Suitable for local kind / internal EC2 testing only. |
| **Grafana credentials hardcoded** | Admin password (`hkbus123`) is set via environment variable in the Grafana deployment. Rotate before any public exposure. |
| **Data scope** | The 84M raw KMB ETA records were collected via a long-running EC2 collector. The 24.8M figure refers to the `eta_seq=1` filtered subset used as Spark input. A fresh kind deployment starts with an empty database; Spark results are pre-loaded from a dump in DEPLOY.md Step 6. |

