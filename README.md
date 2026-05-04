# HK Transit Real-Time Tracker

A cloud-native transit tracking and analytics system for Hong Kong, built as a full reimplementation of an AWS serverless architecture using open-source alternatives deployed on Kubernetes.

Real-time ETA data is collected from the KMB (bus) and MTR (rail) public APIs, streamed through Redis Streams, stored in PostgreSQL, processed by OpenFaaS serverless functions, and visualised in a React web app and Grafana dashboards.

---

## AWS → Open-Source Mapping

| AWS Service | Open-Source Replacement | Role in This Project |
|---|---|---|
| **AWS Lambda** | **OpenFaaS** | `kmb-fetcher` and `compute-analytics` functions |
| **Amazon Kinesis** | **Redis Streams** | `kmb-eta-raw` stream between fetcher and alerter |
| **CloudWatch Events (cron)** | **Kubernetes CronJob** | Triggers functions every minute / every hour |
| **RDS (PostgreSQL)** | **PostgreSQL 15** | All ETA records, analytics, alert tables |
| **ElastiCache (Redis)** | **Redis 7** | Stream bus + API response caching |
| **API Gateway** | **Traefik** (k3s built-in) | Routes `/api/*`, WebSocket, and frontend traffic |
| **ECS / Fargate** | **Kubernetes (k3s)** | Orchestrates all services |
| **CloudWatch Dashboards** | **Grafana** | KMB analytics, MTR overview, system health |
| **Auto Scaling** | **Kubernetes HPA** | CPU/memory-based scaling for the web API |

---

## Architecture

```
 KMB Gov API ──► OpenFaaS: kmb-fetcher (every 1 min)
                      │  publishes via XADD
                      ▼
               Redis Stream: kmb-eta-raw ──► delay-alerter (XREAD consumer)
                                                  │ writes alerts
                                                  ▼
 MTR Gov API ──► eta-fetcher (continuous) ──► PostgreSQL
                      │                         │
                      │                    kmb.eta  mtr.eta
                      │                         │
                      │              OpenFaaS: compute-analytics (every 1 hr)
                      │                         │ writes
                      │                    kmb.analytics
                      │
              ┌────────────────────┐
              │   web-app (React)  │◄── hk-bus-api (Express + Redis cache)
              └────────────────────┘
                      │
                 Traefik Ingress (port 80)

              Grafana (port 30400) ◄── queries PostgreSQL directly
```

---

## Prerequisites

- Ubuntu 22.04 / 24.04 x86_64 server (EC2, VM, or bare metal)
- 2+ CPU cores, 8 GB RAM minimum
- Ports 80 and 30400 open in your firewall / security group
- Internet access to pull images and reach the KMB/MTR APIs

---

## Setup From Scratch

### 1. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
```

### 2. Install k3s (lightweight Kubernetes)

```bash
curl -sfL https://get.k3s.io | sh -
# Verify
sudo k3s kubectl get nodes
```

### 3. Install Helm

```bash
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
```

### 4. Clone the repository

```bash
git clone <repo-url> hk-bus
cd hk-bus
```

### 5. Build all Docker images

The pre-built images on Docker Hub are ARM64 (built on Apple Silicon). On an x86_64 server you must build locally:

```bash
# Core services
docker build -t hk-bus-eta-fetcher:local      -f k8s/eta-fetcher/Dockerfile       k8s/eta-fetcher/
docker build -t hk-bus-web-app:local           -f web-app/Dockerfile               web-app/

# OpenFaaS functions
docker build -t hk-bus-kmb-fetcher:local       -f functions/kmb-fetcher/Dockerfile functions/kmb-fetcher/
docker build -t hk-bus-compute-analytics:local -f functions/compute-analytics/Dockerfile functions/compute-analytics/
docker build -t hk-bus-delay-alerter:local     -f k8s/delay-alerter/Dockerfile    k8s/delay-alerter/
```

### 6. Import images into k3s

k3s uses its own containerd runtime and does not share the Docker image cache. Each image must be imported:

```bash
for img in hk-bus-eta-fetcher hk-bus-web-app hk-bus-kmb-fetcher hk-bus-compute-analytics hk-bus-delay-alerter; do
  echo "Importing ${img}:local ..."
  docker save ${img}:local | sudo k3s ctr images import -
done
```

### 7. Deploy core infrastructure

```bash
sudo k3s kubectl apply -f k8s/namespace.yaml
sudo k3s kubectl apply -f k8s/postgres/secret.yaml
sudo k3s kubectl apply -f k8s/postgres/postgres.yaml
sudo k3s kubectl apply -f k8s/redis.yaml
sudo k3s kubectl apply -f k8s/eta-fetcher/deployment.yaml
sudo k3s kubectl apply -f k8s/backend-api-deployment.yaml
sudo k3s kubectl apply -f k8s/monitoring/grafana.yaml
sudo k3s kubectl apply -f k8s/ingress.yaml

# Wait for all pods to be ready
sudo k3s kubectl get pods -n hk-bus -w
```

Expected output (all pods `1/1 Running`):

```
NAME                           READY   STATUS    RESTARTS   AGE
eta-fetcher-xxx                1/1     Running   0          1m
grafana-xxx                    1/1     Running   0          1m
hk-bus-api-xxx                 1/1     Running   0          1m
postgres-0                     1/1     Running   0          1m
redis-xxx                      1/1     Running   0          1m
```

### 8. Deploy OpenFaaS (Lambda replacement)

```bash
# Add OpenFaaS Helm repo
sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml helm repo add openfaas https://openfaas.github.io/faas-netes/
sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml helm repo update

# Create namespaces
sudo k3s kubectl apply -f https://raw.githubusercontent.com/openfaas/faas-netes/master/namespaces.yml

# Install OpenFaaS
sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml helm install openfaas openfaas/openfaas \
  --namespace openfaas \
  --set functionNamespace=openfaas-fn \
  --set basic_auth=false \
  --set generateBasicAuth=false \
  --set serviceType=NodePort \
  --set gateway.nodePort=31112 \
  --set gateway.readTimeout=300s \
  --set gateway.writeTimeout=300s \
  --set gateway.upstreamTimeout=280s

# Wait for OpenFaaS to be ready
sudo k3s kubectl get pods -n openfaas -w
```

Expected pods in `openfaas` namespace: `alertmanager`, `gateway`, `nats`, `prometheus`, `queue-worker`.

### 9. Deploy OpenFaaS functions and supporting services

```bash
# Copy postgres secret to openfaas-fn namespace (needed by compute-analytics)
PG_PASS=$(sudo k3s kubectl get secret postgres-secret -n hk-bus -o jsonpath='{.data.password}' | base64 -d)
sudo k3s kubectl create secret generic postgres-secret -n openfaas-fn --from-literal=password=${PG_PASS}

# Deploy functions + CronJobs + delay-alerter
sudo k3s kubectl apply -f k8s/openfaas/functions-deployment.yaml
```

This deploys:
- `kmb-fetcher` — OpenFaaS function pod in `openfaas-fn`, invoked every minute by a CronJob
- `compute-analytics` — OpenFaaS function pod in `openfaas-fn`, invoked every hour by a CronJob
- `delay-alerter` — Redis Stream consumer deployment in `hk-bus`

### 10. (Optional) Deploy HPA for web API autoscaling

```bash
sudo k3s kubectl apply -f k8s/hpa.yaml
```

---

## Verify Everything Is Working

### Check all pods

```bash
# Core services
sudo k3s kubectl get pods -n hk-bus

# OpenFaaS gateway + workers
sudo k3s kubectl get pods -n openfaas

# Function pods
sudo k3s kubectl get pods -n openfaas-fn
```

### Test the web app

```bash
curl http://localhost/api/health
# → {"status":"ok","timestamp":"..."}

curl http://localhost/api/routes | python3 -m json.tool | head -20
# → {"routes":[{"route":"1","bound":"I",...}, ...], "count":100}
```

### Manually invoke OpenFaaS functions

```bash
# List all registered functions
curl -s http://127.0.0.1:31112/system/functions | python3 -m json.tool

# Trigger kmb-fetcher (fetches ETA for 22 routes → publishes to Redis Stream)
curl -s -X POST http://127.0.0.1:31112/function/kmb-fetcher \
  -H "Content-Type: application/json" -d '{}'
# → {"published": 2559, "routes": 22, "errors": 0}  (~5 seconds)

# Trigger compute-analytics (compute avg/P95 wait times from DB)
curl -s -X POST http://127.0.0.1:31112/function/compute-analytics \
  -H "Content-Type: application/json" -d '{}'
# → {"ok": true, "rowsAffected": 1296, "elapsedMs": 53751}  (~54 seconds)
```

### Check the Redis Stream and pipeline

```bash
# Stream message count
sudo k3s kubectl exec -n hk-bus deployment/redis -- redis-cli XLEN kmb-eta-raw

# Delay alerts generated by the stream consumer
sudo k3s kubectl exec -n hk-bus statefulset/postgres -- \
  psql -U postgres -d hkbus -c "SELECT COUNT(*) FROM public.delay_alerts;"

# Analytics computed by compute-analytics function
sudo k3s kubectl exec -n hk-bus statefulset/postgres -- \
  psql -U postgres -d hkbus -c "SELECT COUNT(*) FROM kmb.analytics;"
```

---

## Access the Services

| Service | URL |
|---|---|
| **Web App** | `http://<SERVER_IP>/` |
| **API Health** | `http://<SERVER_IP>/api/health` |
| **Grafana** | `http://<SERVER_IP>:30400` |

Get your server's public IP:
```bash
curl -s http://checkip.amazonaws.com
```

> Make sure ports **80** and **30400** are open in your firewall / AWS security group.

---

## Database Schema

| Table / View | Schema | Description |
|---|---|---|
| `routes` | `kmb` | 1,316 KMB routes (both directions) |
| `stops` | `kmb` | 6,725 KMB stop locations |
| `eta` | `kmb` | Raw ETA records — route, stop, wait_minutes, hour_of_day, day_of_week |
| `analytics` | `kmb` | Avg / P95 wait times per route per hour — written by `compute-analytics` |
| `eta` | `mtr` | Raw MTR ETA records — line, station, direction, wait_minutes |
| `delay_alerts` | `public` | Delay events written by `delay-alerter` Redis Stream consumer |

---

## Project Structure

```
hk-bus/
├── k8s/
│   ├── namespace.yaml                   # hk-bus namespace
│   ├── ingress.yaml                     # Traefik ingress (replaces API Gateway)
│   ├── redis.yaml                       # Redis deployment (replaces ElastiCache)
│   ├── hpa.yaml                         # HPA for hk-bus-api (replaces Auto Scaling)
│   ├── postgres/
│   │   ├── postgres.yaml                # StatefulSet + PVC + init schema ConfigMap
│   │   └── secret.yaml                  # DB password
│   ├── eta-fetcher/
│   │   ├── Dockerfile
│   │   ├── server.js                    # Continuous KMB + MTR ETA collector
│   │   └── deployment.yaml
│   ├── backend-api-deployment.yaml      # Web app Deployment + Service
│   ├── delay-alerter/
│   │   ├── Dockerfile
│   │   └── server.js                    # Redis Stream consumer → delay_alerts
│   ├── monitoring/
│   │   └── grafana.yaml                 # Grafana + 3 dashboard ConfigMaps
│   └── openfaas/
│       └── functions-deployment.yaml    # Function Deployments + CronJobs + delay-alerter
├── functions/
│   ├── kmb-fetcher/                     # OpenFaaS fn: KMB API → Redis Stream
│   │   ├── Dockerfile
│   │   ├── handler.py                   # Flask HTTP server, publishes via XADD
│   │   ├── requirements.txt
│   │   └── stops_config.json            # Stop IDs and route filter list
│   └── compute-analytics/              # OpenFaaS fn: kmb.eta → kmb.analytics
│       ├── Dockerfile
│       ├── handler.js                   # Express HTTP server, avg/P95 query
│       └── package.json
├── web-app/
│   ├── Dockerfile                       # Multi-stage: Vite build + Express serve
│   ├── backend/server.js                # Express API — routes, stops, ETA, MTR
│   └── frontend/src/
│       ├── App.jsx
│       ├── components/RouteDetailsView.jsx
│       ├── components/BusStopView.jsx
│       └── components/MtrView.jsx
├── monitoring/
│   └── grafana/dashboard-files/         # KMB analytics, MTR overview, system health
└── docker-compose.collector.yml         # Local dev stack (Postgres + eta-fetcher + Grafana)
```

---

## Grafana Dashboards

Login at `http://<SERVER_IP>:30400` — no password required.

| Dashboard | What it shows |
|---|---|
| **KMB Analytics** | Total ETA records, delay rate, top delayed routes, wait time distribution |
| **MTR Overview** | Avg / P95 wait by line, hourly wait trends, per-station breakdown |
| **System Health** | KMB / MTR ingestion rate per minute, table sizes, last fetch timestamp |

---

## Web App Features

- **Bus tab** — Search any KMB route, see real-time ETA at every stop with an interactive map
- **MTR tab** — Select any MTR line and station, see live train arrivals for both directions (auto-refreshes every 30 s)

---

## Local Development

```bash
# Spin up Postgres + eta-fetcher + Grafana locally with Docker Compose
docker compose -f docker-compose.collector.yml up -d

# Web app: http://localhost:8080
# Grafana: http://localhost:3001
```

---

## Troubleshooting

**`exec format error` on pod startup**
The pre-built Docker Hub images are ARM64. Build locally and import into k3s as shown in steps 5–6.

**`/api/routes` returns error**
The route list is served from the local `kmb.routes` table. If the table is empty, wait 60 seconds for the `eta-fetcher` to complete its first cycle and populate it.

**OpenFaaS function not invoked by CronJob**
The CronJobs call the function services directly (`kmb-fetcher.openfaas-fn.svc.cluster.local:8080`). Check the function pod is `Ready`:
```bash
sudo k3s kubectl get pods -n openfaas-fn
```

**Grafana shows no data**
The `eta-fetcher` needs a few minutes to collect its first batch. Check its logs:
```bash
sudo k3s kubectl logs -n hk-bus deployment/eta-fetcher --tail=20
```
