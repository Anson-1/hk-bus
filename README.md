# 🚌 HK Bus Real-Time Tracker

A cloud-native, event-driven bus tracking system for Hong Kong — built as an open-source reimplementation of an AWS serverless architecture, deployable to Kubernetes.

**Operators**: KMB + Citybus (CTB) | **Updates**: Every 15 s | **Stack**: Kafka · PostgreSQL · Redis · Prometheus · Grafana

---

## AWS → Open-Source Mapping

| AWS Service | Open-Source Replacement | Role in This Project |
|---|---|---|
| Kinesis Data Streams | **Apache Kafka 3.7** (KRaft) | ETA event stream between fetcher and aggregator |
| RDS (PostgreSQL) | **PostgreSQL 15** | Persistent storage for raw ETAs, analytics, alerts |
| ElastiCache (Redis) | **Redis 7** | 15 s TTL cache for live route data; 24 h TTL for stop details |
| CloudWatch Metrics | **Prometheus 2.51** | Scrapes metrics from all services every 15 s |
| QuickSight / CloudWatch Dashboards | **Grafana 10.4** | Three pre-built dashboards with live Prometheus + PostgreSQL data |
| Lambda (event-triggered) | **delay-alerter service** | Consumes `eta-events` Kafka topic; writes to `delay_alerts` when `rmk_en` signals a delay |

---

## Architecture

```
 KMB API ──┐
           ├──► eta-fetcher ──► Kafka (eta-events) ──► eta-aggregator ──► PostgreSQL
 CTB API ──┘         │                                       │
                     │                               delay-alerter
                     ▼
                PostgreSQL                                   │
                     │                                       ▼
             web-app backend ◄── Redis cache          delay_alerts table
                     │
                     ▼
             web-app frontend (React)

 Prometheus ◄── scrapes all services every 15 s
 Grafana    ◄── queries Prometheus + PostgreSQL
```

---

## Services

| Service | Port | AWS Equivalent | Description |
|---|---|---|---|
| web-app | 3000 | ELB + EC2 | React frontend + Express/Node API |
| postgres | — | RDS | Raw ETAs, analytics, alerts, stops |
| kafka | — | Kinesis | Event bus between fetcher and aggregator |
| redis | 6379 | ElastiCache | Route and stop caching |
| eta-fetcher | 3002 | Kinesis Producer | Polls KMB + CTB APIs every 15 s, publishes to Kafka |
| eta-aggregator | 3003 | Kinesis Consumer | Consumes Kafka, writes to PostgreSQL, computes hourly analytics |
| delay-alerter | 3004 | Lambda | Kafka consumer; inserts delay events to `delay_alerts` |
| prometheus | 9090 | CloudWatch Metrics | Scrapes all services |
| grafana | 3001 | QuickSight | Three dashboards (ETA analytics, system health, operator comparison) |
| redis-exporter | 9121 | — | Exposes Redis metrics to Prometheus |

---

## Quick Start

### Prerequisites
- Docker Desktop (Docker Compose v2)
- ~3 GB free disk space

### Run

```bash
git clone <repo-url>
cd hk-bus
docker compose up -d
```

All services start automatically. Allow ~90 s for Kafka to become healthy.

### Access

| URL | Service |
|---|---|
| http://localhost:3000 | Web App — search any KMB or Citybus route |
| http://localhost:3001 | Grafana (admin / hkbus123) |
| http://localhost:9090 | Prometheus |

---

## Features

### Web App
- Search across all KMB and Citybus routes
- Real-time ETA for every stop on a route (updates every second via polling)
- Interactive Leaflet map showing stop positions
- WebSocket subscription for server-push updates

### Grafana Dashboards
1. **ETA Analytics** — Average and P95 wait times per route, sourced from `eta_analytics` table
2. **System Health** — Prometheus metrics: Kafka lag, Redis memory, API request rates, active routes
3. **Operator Comparison** — Side-by-side KMB vs CTB route counts, average waits, delay events

### Data Pipeline
1. `eta-fetcher` polls KMB ETA Bus API + CTB Open Data API every 15 s
2. Each ETA event is published to Kafka topic `eta-events`
3. `eta-aggregator` consumes events, writes to `eta_raw` + `eta_realtime`, computes hourly `eta_analytics`
4. `delay-alerter` consumes same topic, writes to `delay_alerts` when API response contains a delay remark
5. `web-app` backend serves live data from PostgreSQL (Redis-cached) to the frontend

---

## Kubernetes Deployment

Manifests are in `k8s/`. Services have health checks and resource limits.

```bash
# Create namespace
kubectl create namespace hk-bus

# Apply all manifests
kubectl apply -f k8s/ -n hk-bus

# Check status
kubectl get pods -n hk-bus

# Forward web-app to localhost
kubectl port-forward svc/web-app 3000:3000 -n hk-bus
```

---

## Project Structure

```
hk-bus/
├── docker-compose.yml
├── k8s/
│   ├── postgres/init.sql          # Schema: eta_raw, eta_realtime, eta_analytics, stops, delay_alerts
│   ├── eta-fetcher/               # Node.js — KMB + CTB poller → Kafka + PostgreSQL
│   ├── eta-aggregator/            # Node.js — Kafka consumer → PostgreSQL + analytics
│   ├── delay-alerter/             # Node.js — Kafka consumer → delay_alerts table
│   └── openfaas/                  # OpenFaaS Function definition (K8s serverless pattern)
├── web-app/
│   ├── backend/server.js          # Express API — Redis cache, PostgreSQL queries, CTB proxy
│   └── frontend/                  # React — search, route details, Leaflet map
└── monitoring/
    ├── prometheus/prometheus.yml   # Static scrape targets
    └── grafana/
        ├── datasources/            # PostgreSQL + Prometheus datasources
        ├── dashboards/             # Dashboard provider config
        └── dashboard-files/        # Three pre-built dashboard JSONs
```

---

## Database Schema

| Table | Description |
|---|---|
| `eta_raw` | Every raw ETA record from KMB + CTB (route, stop, eta timestamp, company) |
| `eta_realtime` | Windowed aggregates: avg wait per route/stop per 5-min window |
| `eta_analytics` | Hourly avg + P95 wait by route, hour-of-day, day-of-week |
| `stops` | Stop ID → English and Chinese name lookup |
| `delay_alerts` | Delay events written by the delay-alerter serverless function |

---

## Common Commands

```bash
# View running containers
docker compose ps

# Stream logs from a service
docker compose logs -f eta-fetcher

# Check Prometheus targets (should all be UP)
open http://localhost:9090/targets

# Restart a single service
docker compose restart web-app

# Full clean restart (drops volumes)
docker compose down -v && docker compose up -d

# Check API health
curl http://localhost:3000/api/health

# Check recent delay alerts
curl http://localhost:3000/api/alerts/recent
```

---

## Troubleshooting

**Kafka not healthy after 2 min** — `docker compose restart kafka`

**Grafana shows "No data"** — Wait 5 min for `eta-fetcher` to populate data; ensure PostgreSQL datasource uses host `postgres` (not `localhost`).

**Port conflict** — Edit the left-hand port in `docker-compose.yml` (e.g. change `"3000:3000"` to `"3010:3000"`).

---

*KMB ETABus API · Citybus Open Data API · Built with Kafka · PostgreSQL · Redis · Prometheus · Grafana*
