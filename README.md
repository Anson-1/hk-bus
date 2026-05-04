# HK Transit Real-Time Tracker

A cloud-native transit tracking and analytics system for Hong Kong — combining **Option 1** (AWS serverless reimplementation on Kubernetes) and **Option 2** (distributed data analysis with Spark) for the cloud computing course project.

---

## Project Overview

Real-time ETA data is collected from the KMB (bus) and MTR (rail) public APIs, stored in PostgreSQL, visualised in Grafana, and exposed through a React web app. The entire stack runs on Kubernetes, with AWS services replaced by open-source equivalents. A Spark analysis layer draws insights from the collected dataset.

---

## Part 1 — AWS Serverless Reimplementation (Option 1)

### AWS → Open-Source Mapping

| AWS Service | Open-Source Replacement | Role |
|---|---|---|
| Kinesis Data Streams | **Direct API polling** (Node.js worker pool) | ETA fetcher polls KMB + MTR APIs every 15–30 s with concurrency control |
| RDS (PostgreSQL) | **PostgreSQL 15** | Stores all ETA records, analytics views, materialized views |
| ElastiCache (Redis) | **Redis 7** | 15 s TTL cache for live route data; 24 h TTL for stop details |
| CloudWatch Dashboards | **Grafana 10.4** | Three dashboards querying PostgreSQL directly |
| API Gateway + ELB | **Nginx Ingress** (K8s) | Routes `/api/*` and WebSocket traffic to the web app |
| ECS / Fargate | **Kubernetes** | Orchestrates all services with health checks and resource limits |

### Design Decisions

**Why not Apache Kafka for the ETA stream?**
The initial design used Kafka (Kinesis replacement) between the fetcher and aggregator. During implementation we discovered the KMB and MTR public APIs enforce strict per-IP rate limits: KMB returns HTTP 403 after ~5 concurrent requests, and MTR throttles aggressively from non-HK IPs. A Kafka pipeline requires a separate consumer to re-query the API for each event, doubling the request rate and triggering bans. The solution was to collapse the fetcher + aggregator into a single service that writes directly to PostgreSQL — eliminating the intermediate queue while preserving the same end-to-end latency. The Node.js worker pool (concurrency=15 for KMB, concurrency=10 for MTR) replicates Kinesis's parallel shard processing model.

**Redis for caching**
Redis 7 is deployed as the ElastiCache replacement. The web app backend uses Redis with a 15-second TTL for live route responses and a 24-hour TTL for stop name lookups, falling back to an in-memory Map if Redis is unavailable. This matches ElastiCache's role in a typical AWS serverless stack.

### Architecture

```
  KMB API ──► eta-fetcher (Node.js) ──► kmb.eta (PostgreSQL)
                    │                         │
  MTR API ──────────┘                   mtr.eta (PostgreSQL)
                                              │
                                    Analytics Views + Mat. Views
                                              │
                              ┌───────────────┴───────────────┐
                              │                               │
                         web-app (React + Express)       Grafana 10.4
                              │
                         MTR Live ETA tab
                         KMB Bus search tab
```

### Services

| Service | Image | Description |
|---|---|---|
| **postgres** | `postgres:15` | Stores KMB + MTR ETA data, analytics views |
| **redis** | `redis:7-alpine` | 15 s TTL cache for live route data; 24 h TTL for stop details |
| **eta-fetcher** | `ansonhui123/hk-bus-eta-fetcher:latest` | Polls KMB (796 routes, ~30 s/cycle) + MTR (10 lines) APIs |
| **web-app** | `ansonhui123/hk-bus-web-app:latest` | React frontend + Express API (KMB bus search, MTR live ETA) |
| **grafana** | `grafana/grafana:10.4.0` | 3 dashboards: KMB Delay Overview, MTR Overview, System Health |

### Database Schema

| Table / View | Type | Description |
|---|---|---|
| `kmb.stops` | Table | 6,725 KMB stop locations |
| `kmb.routes` | Table | 796 KMB routes (both directions) |
| `kmb.eta` | Table | Raw ETA records — route, stop, wait_minutes, remarks, fetched_at |
| `mtr.eta` | Table | Raw MTR ETA records — line, station, direction, wait_minutes |
| `kmb.v_recent_delays` | View | Delay events in the last hour with stop/route names |
| `kmb.v_worst_routes` | View | Routes ranked by true delay % (min 20 samples) |
| `kmb.v_delay_by_hour` | View | Delay frequency by hour-of-day and day-of-week |
| `kmb.mv_route_reliability` | Mat. View | Per-route avg/P50/P95 wait by hour — refreshed hourly |
| `mtr.v_station_hourly` | View | Per-station avg/P95 wait by hour |

### Kubernetes Deployment

Manifests are in `k8s/`. All images are on Docker Hub.

```bash
# 1. Install nginx ingress controller (replaces AWS API Gateway)
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
kubectl wait --namespace ingress-nginx --for=condition=ready pod \
  --selector=app.kubernetes.io/component=controller --timeout=90s

# 2. Create namespace + secret
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/postgres/secret.yaml

# 3. Deploy all services
kubectl apply -f k8s/postgres/postgres.yaml
kubectl apply -f k8s/redis.yaml
kubectl apply -f k8s/eta-fetcher/deployment.yaml
kubectl apply -f k8s/backend-api-deployment.yaml
kubectl apply -f k8s/monitoring/grafana.yaml
kubectl apply -f k8s/ingress.yaml

# 4. Check status
kubectl get pods -n hk-bus

# 5. Access via ingress (port 80)
# open http://localhost        → Web App
# open http://localhost/api/health

# Or via port-forward:
kubectl port-forward svc/hk-bus-api 8080:3000 -n hk-bus
# open http://localhost:8080

kubectl port-forward svc/grafana-monitoring 3001:3000 -n hk-bus
# open http://localhost:3001  (admin / hkbus123)
```

### Local Development (Docker Compose)

```bash
docker compose -f docker-compose.collector.yml up -d

# Web app:  http://localhost:8080
# Grafana:  http://localhost:3001  (admin / hkbus123)
```

### Web App Features

- **Bus tab** — Search any KMB route, see real-time ETA at every stop with interactive map
- **MTR tab** — Select any line + station, see live train arrivals for both directions (auto-refreshes every 30 s)

### Grafana Dashboards

1. **KMB Delay Overview** — Total rows, delay rate, delay events over time, top 20 worst routes, recent delay events
2. **MTR Overview** — Avg/P95 wait by line, wait trends over time, hourly breakdown by station
3. **System Health** — KMB/MTR ingestion rates per minute, table size, last fetch timestamp

---

## Part 2 — Spark Data Analysis (Option 2)

> **Status**: Data collection running on EC2 (AWS ap-east-1). Analysis to be run after sufficient data is collected (target: 7+ days).

### Data Collection (EC2)

An EC2 instance in AWS ap-east-1 runs the `docker-compose.collector.yml` stack continuously:
- KMB: ~796 routes × both directions, full cycle every ~30 seconds
- MTR: 10 lines × all stations, every 30 seconds
- Expected data volume: ~500K KMB rows/day + ~50K MTR rows/day

### Planned Spark Analysis

The following insights will be drawn from the collected dataset:

1. **KMB Route Reliability Ranking** — Which routes have the highest delay rates? Does it vary by time of day or day of week?
2. **Peak Hour Analysis** — When are buses most delayed? Compare morning vs evening rush hours.
3. **Wait Time Distribution** — P50 vs P95 wait times across all routes — how predictable is KMB?
4. **MTR vs KMB Comparison** — Average wait times across both operators by hour of day.
5. **Spatial Delay Patterns** — Which areas of HK (by stop cluster) experience more delays?

### EC2 To-Do

- [ ] Verify data collection is running: `docker compose -f docker-compose.collector.yml ps`
- [ ] Wait for 7+ days of data
- [ ] Export data from PostgreSQL: `pg_dump` or `COPY kmb.eta TO '/tmp/kmb_eta.csv' CSV HEADER`
- [ ] Run Spark analysis (PySpark on local or EMR)
- [ ] Document insights in the project report

---

## Project Structure

```
hk-bus/
├── docker-compose.collector.yml     # Local/EC2 deployment (Postgres + eta-fetcher + Grafana)
├── init_schema.sql                  # Full DB schema: tables, indexes, views, materialized views
├── k8s/
│   ├── namespace.yaml
│   ├── ingress.yaml                 # Nginx ingress (replaces AWS API Gateway)
│   ├── redis.yaml                   # Redis deployment (replaces AWS ElastiCache)
│   ├── postgres/
│   │   ├── postgres.yaml            # StatefulSet + Service + ConfigMap (init schema)
│   │   └── secret.yaml              # DB password secret
│   ├── eta-fetcher/
│   │   └── deployment.yaml          # ETA collector — KMB + MTR
│   ├── backend-api-deployment.yaml  # Web app (React + Express) Deployment + Service
│   └── monitoring/
│       └── grafana.yaml             # Grafana Deployment + 3 dashboard ConfigMaps
├── web-app/
│   ├── backend/server.js            # Express API — KMB route search, MTR live ETA
│   └── frontend/src/
│       ├── App.jsx                  # Tab layout (Bus / MTR)
│       ├── components/SearchBar.jsx
│       ├── components/RouteDetailsView.jsx
│       └── components/MtrView.jsx   # MTR live ETA tab
└── monitoring/
    └── grafana/
        └── dashboard-files/         # KMB Delay Overview, MTR Overview, System Health JSONs
```

---

## What's Done / What's Left

### Done
- [x] Real-time KMB + MTR ETA collection (EC2, running continuously)
- [x] PostgreSQL schema with 5 analytics objects (views + materialized view)
- [x] Web app with KMB bus search + MTR live ETA tab
- [x] Grafana dashboards (KMB delays, MTR wait times, system health)
- [x] Kubernetes manifests for all services (tested on local kind cluster)
- [x] All Docker images pushed to Docker Hub

### To Do
- [ ] Collect 7+ days of data on EC2
- [ ] Export dataset and run Spark analysis
- [ ] Write project report (architecture decisions, AWS mapping, insights)
