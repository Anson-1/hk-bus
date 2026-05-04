# Full Stack Deployment Guide

Complete step-by-step instructions for deploying the HK Transit Real-Time Tracker on a fresh server from zero. Follow the steps in order — each section has an expected output so you can verify before continuing.

---

## Server Requirements

| Requirement | Minimum |
|---|---|
| OS | Ubuntu 22.04 or 24.04 (x86_64) |
| CPU | 2 cores |
| RAM | 8 GB |
| Disk | 20 GB |
| Inbound ports | 22 (SSH), 80 (web app), 30400 (Grafana), 31112 (OpenFaaS gateway) |

If using AWS EC2, add these ports to your security group inbound rules before starting.

---

## Step 1 — Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker

# Verify
docker run --rm hello-world
```

Expected: `Hello from Docker!`

---

## Step 2 — Install k3s

k3s is a lightweight Kubernetes distribution — single binary, no separate etcd.

```bash
curl -sfL https://get.k3s.io | sh -

# Verify
sudo k3s kubectl get nodes
```

Expected:
```
NAME     STATUS   ROLES           AGE   VERSION
<host>   Ready    control-plane   30s   v1.xx.x+k3s1
```

---

## Step 3 — Install Helm

```bash
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# Verify
helm version
```

---

## Step 4 — Clone the Repository

```bash
git clone https://github.com/Anson-1/hk-bus.git
cd hk-bus
```

---

## Step 5 — Build All Docker Images

> **Why build locally?**
> The pre-built images on Docker Hub are ARM64 (built on Apple Silicon).
> Any x86_64 server must build from source — otherwise pods crash with
> `exec format error`.

Build all 5 images. This takes about 3–5 minutes total.

```bash
# Core services
docker build -t hk-bus-eta-fetcher:local \
  -f k8s/eta-fetcher/Dockerfile k8s/eta-fetcher/

docker build -t hk-bus-web-app:local \
  -f web-app/Dockerfile web-app/

# OpenFaaS functions
docker build -t hk-bus-kmb-fetcher:local \
  -f functions/kmb-fetcher/Dockerfile functions/kmb-fetcher/

docker build -t hk-bus-compute-analytics:local \
  -f functions/compute-analytics/Dockerfile functions/compute-analytics/

docker build -t hk-bus-delay-alerter:local \
  -f k8s/delay-alerter/Dockerfile k8s/delay-alerter/
```

Verify all images exist:
```bash
docker images | grep hk-bus
```

Expected (5 rows):
```
hk-bus-delay-alerter        local   ...
hk-bus-compute-analytics    local   ...
hk-bus-kmb-fetcher          local   ...
hk-bus-web-app              local   ...
hk-bus-eta-fetcher          local   ...
```

---

## Step 6 — Import Images into k3s

k3s uses its own `containerd` runtime and does **not** share Docker's image cache.
Every image must be explicitly imported.

```bash
for img in hk-bus-eta-fetcher hk-bus-web-app hk-bus-kmb-fetcher \
           hk-bus-compute-analytics hk-bus-delay-alerter; do
  echo "Importing ${img}:local ..."
  docker save ${img}:local | sudo k3s ctr images import -
done
```

Verify imports:
```bash
sudo k3s ctr -n k8s.io images ls | grep hk-bus
```

Expected: 5 lines, all showing `linux/amd64`.

---

## Step 7 — Deploy Core Infrastructure

Apply manifests in this exact order. Each depends on the previous.

```bash
# Namespace
sudo k3s kubectl apply -f k8s/namespace.yaml

# Database credentials
sudo k3s kubectl apply -f k8s/postgres/secret.yaml

# PostgreSQL (StatefulSet + PVC + schema init)
sudo k3s kubectl apply -f k8s/postgres/postgres.yaml

# Redis
sudo k3s kubectl apply -f k8s/redis.yaml
```

Wait for Postgres and Redis to be ready before continuing:
```bash
sudo k3s kubectl wait --for=condition=ready pod \
  -l app=postgres -n hk-bus --timeout=120s

sudo k3s kubectl wait --for=condition=ready pod \
  -l app=redis -n hk-bus --timeout=60s
```

Expected:
```
pod/postgres-0 condition met
pod/redis-xxx condition met
```

Verify the database schema was initialised:
```bash
sudo k3s kubectl exec -n hk-bus statefulset/postgres -- \
  psql -U postgres -d hkbus -c "\dn"
```

Expected: schemas `kmb`, `mtr`, `public` listed.

---

## Step 8 — Deploy Data Collection (eta-fetcher)

The eta-fetcher polls KMB every 15s and MTR every 30s and writes to PostgreSQL.

```bash
sudo k3s kubectl apply -f k8s/eta-fetcher/deployment.yaml
```

Wait for it to start:
```bash
sudo k3s kubectl wait --for=condition=ready pod \
  -l app=eta-fetcher -n hk-bus --timeout=60s
```

Check it is collecting data (wait ~30 seconds then run):
```bash
sudo k3s kubectl logs -n hk-bus deployment/eta-fetcher --tail=10
```

Expected: lines like `[KMB] Cycle done in 40.2s | inserted=12000 errors=0`

---

## Step 9 — Deploy Web App and Grafana

```bash
sudo k3s kubectl apply -f k8s/backend-api-deployment.yaml
sudo k3s kubectl apply -f k8s/monitoring/grafana.yaml
sudo k3s kubectl apply -f k8s/ingress.yaml
```

Wait for both to be ready:
```bash
sudo k3s kubectl wait --for=condition=ready pod \
  -l app=hk-bus-api -n hk-bus --timeout=60s

sudo k3s kubectl wait --for=condition=ready pod \
  -l app=grafana -n hk-bus --timeout=60s
```

Quick smoke test:
```bash
curl -s http://localhost/api/health
```

Expected: `{"status":"ok","timestamp":"..."}`

---

## Step 10 — Deploy OpenFaaS (Lambda Replacement)

```bash
# Add Helm repo (must run as sudo to access k3s kubeconfig)
sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml \
  helm repo add openfaas https://openfaas.github.io/faas-netes/

sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml helm repo update

# Create openfaas and openfaas-fn namespaces
sudo k3s kubectl apply -f \
  https://raw.githubusercontent.com/openfaas/faas-netes/master/namespaces.yml

# Install OpenFaaS
sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml \
  helm install openfaas openfaas/openfaas \
  --namespace openfaas \
  --set functionNamespace=openfaas-fn \
  --set basic_auth=false \
  --set generateBasicAuth=false \
  --set serviceType=NodePort \
  --set gateway.nodePort=31112 \
  --set gateway.readTimeout=300s \
  --set gateway.writeTimeout=300s \
  --set gateway.upstreamTimeout=280s
```

Wait for OpenFaaS pods:
```bash
sudo k3s kubectl wait --for=condition=ready pod \
  -l app=gateway -n openfaas --timeout=120s
```

Verify the gateway is up:
```bash
curl -s http://127.0.0.1:31112/healthz
```

Expected: `OK`

---

## Step 11 — Deploy OpenFaaS Functions

The OpenFaaS Community Edition restricts deployment of local images via its REST
API. Functions are instead deployed as standard K8s Deployments in the
`openfaas-fn` namespace — the gateway auto-discovers and proxies to any service
there by name.

```bash
# Copy the postgres secret into openfaas-fn namespace
# (compute-analytics needs DB access)
PG_PASS=$(sudo k3s kubectl get secret postgres-secret \
  -n hk-bus -o jsonpath='{.data.password}' | base64 -d)

sudo k3s kubectl create secret generic postgres-secret \
  -n openfaas-fn --from-literal=password=${PG_PASS}

# Deploy functions, CronJobs, and delay-alerter
sudo k3s kubectl apply -f k8s/openfaas/functions-deployment.yaml
```

Wait for function pods:
```bash
sudo k3s kubectl wait --for=condition=ready pod \
  -l faas_function=kmb-fetcher -n openfaas-fn --timeout=60s

sudo k3s kubectl wait --for=condition=ready pod \
  -l faas_function=compute-analytics -n openfaas-fn --timeout=60s

sudo k3s kubectl wait --for=condition=ready pod \
  -l app=delay-alerter -n hk-bus --timeout=60s
```

---

## Step 12 — Verify the Full Pipeline

### 12a. Check all pods are running

```bash
echo "=== hk-bus ===" && sudo k3s kubectl get pods -n hk-bus
echo "=== openfaas ===" && sudo k3s kubectl get pods -n openfaas
echo "=== openfaas-fn ===" && sudo k3s kubectl get pods -n openfaas-fn
```

Expected — all pods `1/1 Running`:

| Namespace | Pod | Role |
|---|---|---|
| hk-bus | postgres-0 | Database |
| hk-bus | redis-xxx | Cache + Stream bus |
| hk-bus | eta-fetcher-xxx | Continuous ETA collector |
| hk-bus | hk-bus-api-xxx | Web app backend |
| hk-bus | grafana-xxx | Dashboards |
| hk-bus | delay-alerter-xxx | Redis Stream consumer |
| openfaas | gateway-xxx (2/2) | OpenFaaS gateway + provider |
| openfaas | nats-xxx | Message bus |
| openfaas | queue-worker-xxx | Async function queue |
| openfaas | prometheus-xxx | Metrics |
| openfaas | alertmanager-xxx | Alerts |
| openfaas-fn | kmb-fetcher-xxx | ETA fetch function |
| openfaas-fn | compute-analytics-xxx | Analytics function |

### 12b. List registered OpenFaaS functions

```bash
curl -s http://127.0.0.1:31112/system/functions | python3 -m json.tool
```

Expected: JSON array with `kmb-fetcher` and `compute-analytics`, each showing
`"availableReplicas": 1`.

### 12c. Invoke kmb-fetcher via the gateway

```bash
curl -s -X POST http://127.0.0.1:31112/function/kmb-fetcher \
  -H "Content-Type: application/json" -d '{}'
```

Expected (completes in ~5 seconds):
```json
{"published": 2559, "routes": 22, "errors": 0}
```

### 12d. Invoke compute-analytics via the gateway

```bash
curl -s -X POST http://127.0.0.1:31112/function/compute-analytics \
  -H "Content-Type: application/json" -d '{}'
```

Expected (completes in ~30–60 seconds):
```json
{"ok": true, "rowsAffected": 1296, "elapsedMs": 53000}
```

### 12e. Check the Redis Stream

```bash
sudo k3s kubectl exec -n hk-bus deployment/redis -- redis-cli XLEN kmb-eta-raw
```

Expected: a positive number (grows each time kmb-fetcher runs).

### 12f. Check the database

```bash
sudo k3s kubectl exec -n hk-bus statefulset/postgres -- \
  psql -U postgres -d hkbus -c "
    SELECT 'kmb.routes'      AS table, COUNT(*) FROM kmb.routes
    UNION ALL
    SELECT 'kmb.stops',               COUNT(*) FROM kmb.stops
    UNION ALL
    SELECT 'kmb.eta',                 COUNT(*) FROM kmb.eta
    UNION ALL
    SELECT 'mtr.eta',                 COUNT(*) FROM mtr.eta
    UNION ALL
    SELECT 'kmb.analytics',           COUNT(*) FROM kmb.analytics
    UNION ALL
    SELECT 'public.delay_alerts',     COUNT(*) FROM public.delay_alerts;"
```

After ~5 minutes of running:

| Table | Expected rows |
|---|---|
| kmb.routes | ~1,316 |
| kmb.stops | ~6,725 |
| kmb.eta | grows continuously |
| mtr.eta | grows continuously |
| kmb.analytics | populated after first compute-analytics run |
| public.delay_alerts | populated after first kmb-fetcher + delay-alerter cycle |

---

## Step 13 — Access the Services

Get the server's public IP:
```bash
curl -s http://checkip.amazonaws.com
```

| Service | URL | Notes |
|---|---|---|
| **Web App** | `http://<IP>/` | KMB bus search + MTR live ETA |
| **API health** | `http://<IP>/api/health` | Should return `{"status":"ok"}` |
| **Grafana** | `http://<IP>:30400` | 3 dashboards, no login required |
| **OpenFaaS Gateway** | `http://<IP>:31112` | Function list + invocation |

> Make sure ports **80**, **30400**, and **31112** are open in your firewall
> or AWS security group.

---

## Automatic CronJob Schedule

Once deployed, functions run automatically — no manual invocation needed:

| Job | Schedule | What it does |
|---|---|---|
| `kmb-fetcher-cron` | Every minute | Fetch 22 routes → publish to Redis Stream |
| `compute-analytics-cron` | Every hour | Compute avg/P95 wait times → write to `kmb.analytics` |

Check CronJob history:
```bash
sudo k3s kubectl get cronjobs,jobs -n hk-bus
```

---

## Troubleshooting

### Pod stays in `CrashLoopBackOff`

Check logs:
```bash
sudo k3s kubectl logs -n hk-bus <pod-name> --tail=30
```

**`exec format error`** — Image built for wrong architecture.
Rebuild and re-import (steps 5–6).

**`password authentication failed`** — Postgres secret mismatch.
```bash
sudo k3s kubectl get secret postgres-secret -n hk-bus \
  -o jsonpath='{.data.password}' | base64 -d
```
Should print `postgres`.

### OpenFaaS gateway returns 502

The function pod isn't ready yet. Check:
```bash
sudo k3s kubectl get pods -n openfaas-fn
sudo k3s kubectl logs -n openfaas-fn deployment/kmb-fetcher --tail=10
```

### Grafana shows "No data"

The eta-fetcher needs 1–2 minutes to complete its first cycle. Check:
```bash
sudo k3s kubectl logs -n hk-bus deployment/eta-fetcher --tail=5
```

### `/api/routes` returns error

The routes table is empty — eta-fetcher hasn't completed its first cycle yet.
Wait 60 seconds and retry.

### compute-analytics CronJob not running

The CronJob runs every hour. Trigger it manually to verify it works:
```bash
curl -s -X POST http://127.0.0.1:31112/function/compute-analytics \
  -H "Content-Type: application/json" -d '{}'
```

---

## Full Re-deploy (Wipe and Start Over)

If something goes wrong and you want a clean slate:

```bash
# Delete everything in hk-bus namespace
sudo k3s kubectl delete namespace hk-bus

# Delete OpenFaaS
sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml \
  helm uninstall openfaas -n openfaas
sudo k3s kubectl delete namespace openfaas openfaas-fn

# Start over from Step 7
```

> Note: deleting the `hk-bus` namespace also deletes the PostgreSQL PVC
> and all collected data.
