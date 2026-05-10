# Deployment Guide

Step-by-step instructions for deploying the HK Transit Real-Time Tracker locally (kind) or on a production server (k3s on EC2).

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| **Docker Desktop** | 4.x+ | https://www.docker.com/products/docker-desktop — set memory limit to **8 GB+** in Settings → Resources |
| **kubectl** | 1.28+ | `brew install kubectl` (Mac) · `winget install Kubernetes.kubectl` (Windows) · https://kubernetes.io/docs/tasks/tools |
| **kind** | 0.20+ | `brew install kind` (Mac) · `winget install Kubernetes.kind` (Windows) · https://kind.sigs.k8s.io/docs/user/quick-start/#installation |
| **git** | any | pre-installed on most systems |

> **Windows (PowerShell) note:** The `base64 -d` command used in step 5 does not exist in PowerShell. Use this instead:
> ```powershell
> $PG_PASS = kubectl get secret postgres-secret -n hk-bus -o jsonpath='{.data.password}' | % { [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($_)) }
> kubectl create secret generic postgres-secret `
>   -n openfaas-fn `
>   --from-literal=password=$PG_PASS `
>   --dry-run=client -o yaml | kubectl apply -f -
> ```
> Also use `$env:VAR` instead of `${VAR}` for environment variables, and omit trailing `&` for background processes (run each `port-forward` in a separate terminal instead).

> **Docker memory**: The Spark analytics job needs 4 GB of driver memory. In Docker Desktop → Settings → Resources, set Memory to at least **8 GB** before running the Spark job.

---

## Part A — Local Deployment (kind)

This path runs the full stack on your laptop using [kind](https://kind.sigs.k8s.io/) (Kubernetes in Docker). No cloud account needed.

### 1. Clone the repository

```bash
git clone https://github.com/Anson-1/hk-bus.git hk-bus
cd hk-bus
```

### 2. Create the kind cluster

```bash
kind create cluster --name hk-bus
```

Verify:
```bash
kubectl cluster-info --context kind-hk-bus
# Kubernetes control plane is running at https://127.0.0.1:...
```

### 3. Pre-load Docker images into kind

kind uses its own containerd runtime and does not share the Docker image cache. Pre-loading avoids slow pulls during pod startup.

```bash
# Pull all images first
docker pull ansonhui123/hk-bus-web-app:latest
docker pull ansonhui123/hk-bus-eta-fetcher:latest
docker pull ansonhui123/kmb-fetcher:latest
docker pull ansonhui123/compute-analytics:latest
docker pull ansonhui123/delay-alerter:latest
docker pull ansonhui123/spark-analytics:latest
docker pull ansonhui123/hk-bus-spark:latest
docker pull heiheivan/traffic-fetcher:latest
docker pull heiheivan/accident-fetcher:latest
docker pull heiheivan/passenger-fetcher:latest
docker pull postgres:15
docker pull redis:7-alpine
docker pull grafana/grafana:10.4.0
docker pull curlimages/curl:latest

# Load into kind cluster
kind load docker-image ansonhui123/hk-bus-web-app:latest      --name hk-bus
kind load docker-image ansonhui123/hk-bus-eta-fetcher:latest  --name hk-bus
kind load docker-image ansonhui123/kmb-fetcher:latest         --name hk-bus
kind load docker-image ansonhui123/compute-analytics:latest   --name hk-bus
kind load docker-image ansonhui123/delay-alerter:latest       --name hk-bus
kind load docker-image ansonhui123/spark-analytics:latest     --name hk-bus
kind load docker-image ansonhui123/hk-bus-spark:latest        --name hk-bus
kind load docker-image heiheivan/traffic-fetcher:latest       --name hk-bus
kind load docker-image heiheivan/accident-fetcher:latest      --name hk-bus
kind load docker-image heiheivan/passenger-fetcher:latest     --name hk-bus
kind load docker-image postgres:15                            --name hk-bus
kind load docker-image redis:7-alpine                         --name hk-bus
kind load docker-image grafana/grafana:10.4.0                 --name hk-bus
kind load docker-image curlimages/curl:latest                 --name hk-bus
```

### 4. Deploy core infrastructure

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/postgres/secret.yaml
kubectl apply -f k8s/postgres/postgres.yaml
kubectl apply -f k8s/redis.yaml
kubectl apply -f k8s/eta-fetcher/deployment.yaml
kubectl apply -f k8s/backend-api-deployment.yaml
kubectl apply -f k8s/monitoring/grafana.yaml
```

Wait for core pods to be ready (takes ~60 seconds):

```bash
kubectl get pods -n hk-bus -w
```

Expected — all `1/1 Running`:
```
NAME                         READY   STATUS    RESTARTS   AGE
eta-fetcher-xxx              1/1     Running   0          60s
grafana-xxx                  1/1     Running   0          60s
hk-bus-api-xxx               1/1     Running   0          60s
postgres-0                   1/1     Running   0          60s
redis-xxx                    1/1     Running   0          60s
```

### 5. Deploy OpenFaaS functions and CronJobs

`compute-analytics` and `spark-analytics` are deployed as real OpenFaaS `Function` CRDs — the OpenFaaS gateway manages their lifecycle and scales them to zero when idle.

Install OpenFaaS first:

```bash
# Install arkade (OpenFaaS installer)
curl -SLs https://get.arkade.dev | sh

# Install OpenFaaS onto the cluster
arkade install openfaas

# Wait for gateway to be ready (~60s)
kubectl rollout status -n openfaas deploy/gateway

# Enable scale-to-zero (Community Edition)
kubectl -n openfaas set env deploy/gateway scale_zero=true
```

The functions run in a separate namespace `openfaas-fn`. Copy the database secret there:

```bash
kubectl create namespace openfaas-fn --dry-run=client -o yaml | kubectl apply -f -

PG_PASS=$(kubectl get secret postgres-secret -n hk-bus -o jsonpath='{.data.password}' | base64 -d)
kubectl create secret generic postgres-secret \
  -n openfaas-fn \
  --from-literal=password=${PG_PASS} \
  --dry-run=client -o yaml | kubectl apply -f -
```

Deploy the functions, CronJobs, and RBAC:

```bash
kubectl apply -f k8s/spark/rbac.yaml
kubectl apply -f k8s/openfaas/functions-deployment.yaml
```

This deploys:
- **kmb-fetcher** — fetches KMB ETA every minute → publishes to Redis Stream
- **compute-analytics** — computes avg/P95 wait times from `kmb.eta` every hour
- **spark-analytics** — triggers the PySpark batch job every day 2 AM HKT
- **delay-alerter** — Redis Stream consumer → writes delay events to PostgreSQL
- **traffic-fetcher** — fetches Smart Lamppost speed/volume data every 2 minutes → `traffic_speed_volume`
- **accident-fetcher** — downloads TD accident CSVs daily → `accident_summary`
- **passenger-fetcher** — downloads IMMD cross-border passenger CSV daily → `passenger_daily_summary`

### 6. Load sample data into PostgreSQL

The Spark analytics results (pre-computed from 14.6 M ETA records) and MTR data are loaded from the local Docker image of PostgreSQL. Start a local postgres container to extract from:

```bash
docker compose -f docker-compose.collector.yml up -d postgres
# Wait ~10 seconds for it to be healthy

docker exec hk-bus-postgres psql -U postgres -d hkbus -c "SELECT COUNT(*) FROM mtr.eta;"
# Should show 295973
```

Load into K8s PostgreSQL:

```bash
# Spark analytics results (6634 + 17 + 697 rows — fast)
docker exec hk-bus-postgres pg_dump -U postgres -d hkbus \
  -t kmb.spark_analytics -t kmb.spark_peak_hours -t kmb.spark_route_reliability \
  --data-only -F plain \
  | kubectl exec -i -n hk-bus postgres-0 -- psql -U postgres -d hkbus

# MTR ETA data (295 K rows — ~30 seconds)
docker exec hk-bus-postgres pg_dump -U postgres -d hkbus \
  -t mtr.eta --data-only -F plain \
  | kubectl exec -i -n hk-bus postgres-0 -- psql -U postgres -d hkbus

# KMB ETA sample (100 K rows — ~15 seconds)
docker exec hk-bus-postgres psql -U postgres -d hkbus \
  -c "\COPY (SELECT * FROM kmb.eta LIMIT 100000) TO STDOUT" \
  | kubectl exec -i -n hk-bus postgres-0 -- psql -U postgres -d hkbus \
  -c "\COPY kmb.eta FROM STDIN"

docker compose -f docker-compose.collector.yml stop postgres
```

Verify:

```bash
kubectl exec -n hk-bus postgres-0 -- psql -U postgres -d hkbus \
  -c "SELECT schemaname, relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 8;"
```

Expected:
```
 schemaname |         relname         | n_live_tup
------------+-------------------------+------------
 mtr        | eta                     |     295973
 kmb        | eta                     |     100000
 kmb        | spark_analytics         |       6634
 public     | delay_alerts            |       ...
 kmb        | spark_route_reliability |        697
 kmb        | spark_peak_hours        |         17
```

### 7. Access the services

kind does not have a load balancer, so use `kubectl port-forward`:

```bash
kubectl port-forward -n hk-bus svc/hk-bus-api 3000:3000 &
kubectl port-forward -n hk-bus svc/grafana-monitoring 3001:3000 &
kubectl port-forward -n openfaas svc/gateway 8888:8080 &
```

| Service | URL | Credentials |
|---|---|---|
| Web app | http://localhost:3000 | — |
| Grafana | http://localhost:3001 | admin / hkbus123 |
| OpenFaaS UI | http://localhost:8888/ui/ | — (auth disabled) |

### 8. Verify the pipeline is live

> **Note:** If your machine has an HTTP proxy configured, add `--noproxy localhost` to all curl commands below.

```bash
# API health
curl --noproxy localhost http://localhost:3000/api/health
# → {"status":"ok","timestamp":"..."}

# MTR ETA (live data from K8s postgres)
curl --noproxy localhost "http://localhost:3000/api/mtr-eta?line=TCL&station=HOK"

# Recent delay alerts written by delay-alerter
curl --noproxy localhost http://localhost:3000/api/alerts/recent

# Redis Stream — kmb-fetcher publishes here every minute
kubectl exec -n hk-bus deployment/redis -- redis-cli XLEN kmb-eta-raw

# Delay alerts table
kubectl exec -n hk-bus postgres-0 -- \
  psql -U postgres -d hkbus -c "SELECT COUNT(*) FROM public.delay_alerts;"

# Invoke compute-analytics manually via OpenFaaS gateway
curl --noproxy localhost -X POST http://localhost:8888/function/compute-analytics \
  -H "Content-Type: application/json" -d '{}'
# → {"ok":true,"rowsAffected":...,"elapsedMs":...}

# List all deployed OpenFaaS functions
curl --noproxy localhost http://localhost:8888/system/functions | python3 -m json.tool
```

---

## Part B — Production Deployment (k3s on EC2)

For an always-on deployment with real traffic. Tested on Ubuntu 22.04 x86_64, 4 vCPU, 8 GB RAM.

### Security group / firewall rules

Open these inbound ports:

| Port | Service |
|---|---|
| 22 | SSH |
| 80 | Web app (Traefik ingress) |
| 30400 | Grafana NodePort |

### 1. Install Docker and k3s

```bash
# Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker

# k3s
curl -sfL https://get.k3s.io | sh -
sudo k3s kubectl get nodes
```

### 2. Clone the repository

```bash
git clone https://github.com/Anson-1/hk-bus.git hk-bus
cd hk-bus
```

### 3. Deploy everything

On k3s, images are pulled directly from Docker Hub — no manual loading needed.

```bash
# Shortcut: k3s kubectl = sudo k3s kubectl
alias k='sudo k3s kubectl'

k apply -f k8s/namespace.yaml
k apply -f k8s/postgres/secret.yaml
k apply -f k8s/postgres/postgres.yaml
k apply -f k8s/redis.yaml
k apply -f k8s/eta-fetcher/deployment.yaml
k apply -f k8s/backend-api-deployment.yaml
k apply -f k8s/monitoring/grafana.yaml
k apply -f k8s/ingress.yaml

# Wait for core pods
k get pods -n hk-bus -w
```

### 4. Deploy OpenFaaS functions

Install OpenFaaS and enable scale-to-zero:

```bash
curl -SLs https://get.arkade.dev | sh
arkade install openfaas
kubectl rollout status -n openfaas deploy/gateway
kubectl -n openfaas set env deploy/gateway scale_zero=true
```

```bash
k create namespace openfaas-fn --dry-run=client -o yaml | k apply -f -

PG_PASS=$(k get secret postgres-secret -n hk-bus -o jsonpath='{.data.password}' | base64 -d)
k create secret generic postgres-secret \
  -n openfaas-fn --from-literal=password=${PG_PASS} \
  --dry-run=client -o yaml | k apply -f -

k apply -f k8s/spark/rbac.yaml
k apply -f k8s/openfaas/functions-deployment.yaml
```

### 5. Access

| Service | URL | Credentials |
|---|---|---|
| Web app | `http://<SERVER_IP>/` | — |
| API health | `http://<SERVER_IP>/api/health` | — |
| Grafana | `http://<SERVER_IP>:30400` | admin / hkbus123 |
| OpenFaaS UI | `http://<SERVER_IP>:31112/ui/` | — (auth disabled) |

Get your server's public IP:
```bash
curl -s http://checkip.amazonaws.com
```

---

## Part C — Running the Spark Analytics Job Locally

The Spark job analyses the raw KMB ETA data and writes results to PostgreSQL. The results are already pre-loaded in step 6 above, but you can re-run the analysis any time.

### Requirements

- Docker Desktop with **8 GB memory** (Settings → Resources → Memory)
- Local postgres running with data (start via `docker compose -f docker-compose.collector.yml up -d postgres`)

### Run

```bash
docker run --rm \
  --network host \
  --memory=8g \
  -e JDBC_URL=jdbc:postgresql://127.0.0.1:5432/hkbus \
  -e DB_USER=postgres \
  -e DB_PASSWORD=postgres \
  ansonhui123/hk-bus-spark:latest
```

The job runs for ~5–10 minutes and writes three tables:

| Table | Rows | Description |
|---|---|---|
| `kmb.spark_analytics` | ~6,600 | Avg/P95 wait per route per hour |
| `kmb.spark_peak_hours` | 17 | System-wide avg/P95 by hour of day |
| `kmb.spark_route_reliability` | ~700 | Per-route reliability score |

View results in Grafana → **Spark Analytics (Batch)** dashboard.

---

## Troubleshooting

**Pods stuck in `ImagePullBackOff`**

```bash
kubectl describe pod <pod-name> -n hk-bus | grep -A5 Events
```

If it can't pull from Docker Hub, pre-load the image manually:
```bash
docker pull <image>
kind load docker-image <image> --name hk-bus
```

**`openfaas-fn` pods in `CreateContainerConfigError`**

The `postgres-secret` is missing from the `openfaas-fn` namespace. Re-run step 5.

**Redis in `CrashLoopBackOff`**

Usually a liveness probe timeout. Check logs:
```bash
kubectl logs -n hk-bus deployment/redis --previous
```
If it shows `SIGTERM` from liveness probe failure, the fix is already in `k8s/redis.yaml` (failureThreshold: 5, timeoutSeconds: 5).

**Spark job OOM (Java heap space)**

Increase Docker Desktop memory to 8 GB. The job needs ~4 GB for the driver heap plus OS overhead.

**`curl` returns 502 / proxy error**

If your machine has an HTTP proxy configured (e.g. `http_proxy` env var), add `--noproxy localhost` to all curl commands targeting localhost:
```bash
curl --noproxy localhost http://localhost:3000/api/health
```

**Grafana shows "No data" on time-series panels**

The KMB time-series panels (`Delay Events Over Time`, `Recent Delay Events`) require live data in `kmb.eta` from the last 3 hours. On a fresh kind cluster these will be empty until the `kmb-fetcher` CronJob has run for a few minutes and the data has been collected. The **Spark Analytics (Batch)** dashboard is static and always shows data.

---

## Updating Spark Analytics with a Full Day of EC2 Data

Once EC2 has collected a full day of KMB ETA data, run the following to refresh the Spark analytics results:

### 1. Dump KMB ETA data from EC2 postgres

```bash
# SSH into EC2 and dump kmb.eta
docker exec <ec2-postgres-container> pg_dump -U postgres -d hkbus \
  -t kmb.eta --data-only -F plain > kmb_eta_full.sql

# Copy to local machine
scp -i <key.pem> ubuntu@<EC2_IP>:~/kmb_eta_full.sql .
```

### 2. Load into local docker-compose postgres

```bash
docker compose -f docker-compose.collector.yml up -d postgres
# Wait ~10s for postgres to be healthy

# Truncate old sample data first
docker exec hk-bus-postgres psql -U postgres -d hkbus \
  -c "TRUNCATE kmb.eta RESTART IDENTITY;"

# Load full dataset
docker exec -i hk-bus-postgres psql -U postgres -d hkbus < kmb_eta_full.sql
```

### 3. Re-run the PySpark job

> Requires Docker Desktop memory set to **8 GB+** (Settings → Resources → Memory).

```bash
docker run --rm \
  --network host \
  --memory=8g \
  -e JDBC_URL=jdbc:postgresql://127.0.0.1:5432/hkbus \
  -e DB_USER=postgres \
  -e DB_PASSWORD=postgres \
  ansonhui123/hk-bus-spark:latest
```

The job takes ~5–10 minutes and overwrites `kmb.spark_analytics`, `kmb.spark_peak_hours`, and `kmb.spark_route_reliability`.

### 4. Load updated results into K8s postgres

```bash
docker exec hk-bus-postgres pg_dump -U postgres -d hkbus \
  -t kmb.spark_analytics -t kmb.spark_peak_hours -t kmb.spark_route_reliability \
  --data-only -F plain \
  | kubectl exec -i -n hk-bus postgres-0 -- psql -U postgres -d hkbus
```

The **Spark Analytics (Batch)** Grafana dashboard will reflect the updated results immediately.
