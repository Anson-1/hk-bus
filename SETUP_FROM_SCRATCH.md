# Complete Setup Guide - From Scratch

Step-by-step guide to set up the HK Bus tracking system on a fresh machine.

---

## Prerequisites

Before starting, ensure you have:

- **macOS or Linux**
- **Docker Desktop** installed ([download here](https://www.docker.com/products/docker-desktop))
- **kubectl** installed (`brew install kubectl`)
- **git** installed (`brew install git`)
- **8GB+ RAM** available
- **20GB+ free disk space**

### Verify Prerequisites

```bash
docker --version        # Should show Docker version 20+
kubectl version         # Should show kubectl version
git --version          # Should show git version
```

---

## Step 1: Enable Kubernetes in Docker Desktop

1. Open **Docker Desktop** app
2. Go to **Settings** → **Kubernetes**
3. Check **"Enable Kubernetes"**
4. Click **"Apply & Restart"** (takes 5-10 minutes)

### Verify Kubernetes is Running

```bash
kubectl config current-context
# Output: docker-desktop

kubectl get nodes
# Output: Should show 1 node named "docker-desktop" with STATUS "Ready"
```

---

## Step 2: Clone the Repository

```bash
# Clone repository
git clone https://github.com/Anson-1/hk-bus.git
cd hk-bus
```

---

## Step 3: Deploy All Services at Once

```bash
# Deploy all services with one command
kubectl apply -f k8s/ -n hk-bus

# The system will automatically pull Docker images from Docker Hub and deploy:
# - PostgreSQL database
# - eta-fetcher (data collection)
# - Backend API
# - Frontend web app
# - Grafana dashboards
```

Wait for all pods to be ready (takes 2-3 minutes):

```bash
kubectl get pods -n hk-bus -w

# Press Ctrl+C when all pods show STATUS "Running"
```

Expected output:
```
NAME                           READY   STATUS    RESTARTS   AGE
postgres-0                     1/1     Running   0          2m
eta-fetcher-xxx-yyy            1/1     Running   0          1m
hk-bus-api-xxx-yyy             1/1     Running   0          1m
hk-bus-web-xxx-yyy             1/1     Running   0          1m
grafana-xxx-yyy                1/1     Running   0          1m
```

### Terminal 1: Web App

```bash
kubectl port-forward -n hk-bus svc/hk-bus-web 8080:80
```

Leave this running.

### Terminal 2: Grafana (Open in a new terminal)

```bash
kubectl port-forward -n hk-bus svc/grafana 3000:3000
```

Leave this running.

---

## Step 5: Open in Browser

### Web App (Route 91M Tracker)

```bash
open http://localhost:8080
```

1. Type `91M` in the search box
2. Click search button
3. You should see **29 bus stops** with live ETA times

**Expected output:**
```
Route 91M - PO LAM to DIAMOND HILL

Upcoming Stops (29):
  1. PO LAM BUS TERMINUS - 0 min (1 sample)
  2. YAN KING ROAD - 0 min (1 sample)
  ...
  6. HANG HAU STATION - 6 min (1 sample)
  ...
  13. H.K.U.S.T. (SOUTH) - 9 min (1 sample)
  ...
  29. DIAMOND HILL STATION - 21 min (1 sample)
```

Map shows all 29 stops as markers.

### Grafana Analytics Dashboard

```bash
open http://localhost:3000
```

Login:
- Username: `admin`
- Password: `admin`

Click on **"Route 91M - Real-time Analytics"** dashboard.

---

## Step 6: Verify Data Is Flowing

### Check eta-fetcher is collecting data

```bash
kubectl logs -n hk-bus -l app=eta-fetcher --tail=20 -f

# Press Ctrl+C to stop
```

Should show every 15 seconds:
```
✓ Fetched 29 stops for Route 91M(outbound)
✓ Cache hit for Route 91M(outbound) - 29 stops
✅ Fetch cycle complete
```

### Check database has data

```bash
kubectl exec -it postgres-0 -n hk-bus -- \
  psql -U postgres -d hkbus

# Inside PostgreSQL:
SELECT COUNT(*) FROM eta_raw WHERE route='91M';

# Should return: count > 0 (like 50, 100, etc.)

\q  # Exit PostgreSQL
```

### Check API is responding

```bash
curl http://localhost:3001/api/health

# Should return: OK or similar status
```

---

## Expected Data Flow

```
15 seconds:   eta-fetcher polls KMB API
              ↓
              Stores 2,400+ records in PostgreSQL
              ↓
              Backend API queries database
              ↓
              WebSocket broadcasts to frontend
              ↓
              Web app auto-updates (no refresh needed)
              ↓
              Grafana dashboard updates
```

Data updates every 15 seconds automatically.

---

## Troubleshooting

### Pod is "Pending"

```bash
# Check what's wrong
kubectl describe pod <pod-name> -n hk-bus

# Likely causes:
# - Not enough resources
# - Docker Desktop Kubernetes not enabled
# - Image pull failed
```

**Solution**: Restart Docker Desktop and try again.

### Pod is "CrashLoopBackOff"

```bash
# View logs to see error
kubectl logs <pod-name> -n hk-bus --previous

# Check if database is ready
kubectl get pods -n hk-bus | grep postgres
```

**Solution**: Ensure PostgreSQL is running first, then restart other pods:
```bash
kubectl delete pod -n hk-bus <pod-name>  # Will restart automatically
```

### "Failed to fetch route details" in browser

```bash
# Check if backend is running
kubectl get pods -n hk-bus | grep hk-bus-web

# View backend logs
kubectl logs -n hk-bus -l app=hk-bus-web --tail=50

# Check if port-forward is active
# Should see "Handling connection" messages
```

**Solution**: Restart backend:
```bash
kubectl rollout restart deployment/hk-bus-web -n hk-bus
```

### No data in Grafana

```bash
# Check if database has data
kubectl exec -it postgres-0 -n hk-bus -- \
  psql -U postgres -d hkbus -c "SELECT COUNT(*) FROM eta_raw;"

# If 0 records, restart eta-fetcher
kubectl rollout restart deployment/eta-fetcher -n hk-bus

# Wait 30 seconds, then refresh Grafana
```

### Port already in use

```bash
# For port 8080
lsof -i :8080
# Note the PID, then: kill <PID>

# For port 3000
lsof -i :3000
# Note the PID, then: kill <PID>

# Try port-forward again
```

---

## Stop Everything

### Stop port-forwards

In both terminal windows running port-forward, press **Ctrl+C**.

### Stop Kubernetes services

```bash
# Delete entire namespace (removes all services)
kubectl delete namespace hk-bus

# Or keep namespace but stop services
kubectl delete all -n hk-bus --all
```

### Disable Kubernetes (optional)

1. Open Docker Desktop
2. Settings → Kubernetes
3. Uncheck "Enable Kubernetes"
4. Click "Apply & Restart"

---

## Summary of Commands

```bash
# Clone repo
git clone https://github.com/Anson-1/hk-bus.git
cd hk-bus

# Create namespace
kubectl create namespace hk-bus

# Deploy all services (images pulled automatically from Docker Hub)
kubectl apply -f k8s/ -n hk-bus

# Wait for all pods to be ready
kubectl get pods -n hk-bus -w

# Port forward (in separate terminals)
kubectl port-forward -n hk-bus svc/hk-bus-web 8080:80
kubectl port-forward -n hk-bus svc/grafana 3000:3000

# Open browser
open http://localhost:8080    # Web app
open http://localhost:3000    # Grafana

# Verify data is flowing
kubectl logs -n hk-bus -l app=eta-fetcher --tail=20
kubectl exec -it postgres-0 -n hk-bus -- psql -U postgres -d hkbus
```

---

## What Each Service Does

| Service | Purpose | Port |
|---------|---------|------|
| **PostgreSQL** | Database - stores ETA data | 5432 |
| **eta-fetcher** | Polls KMB API every 15s | 3002 |
| **hk-bus-api** | Backend REST API + WebSocket | 3001 |
| **hk-bus-web** | Frontend web app | 3000 |
| **Grafana** | Analytics dashboards | 3000 |

---

## Next Steps

1. ✅ Verify web app shows Route 91M with 29 stops
2. ✅ Check Grafana dashboard shows real-time metrics
3. ✅ Verify data updates every 15 seconds
4. ✅ Share this setup with teammates

For more details, see:
- [README.md](README.md) - Project overview
- [QUICKSTART.md](QUICKSTART.md) - Quick 5-minute start
- [ARCHITECTURE.md](ARCHITECTURE.md) - Technical deep dive
- [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) - Production deployment

---

**Total setup time**: 10-15 minutes on first run

Docker images are automatically pulled from Docker Hub:
- `ansonhui123/hk-bus-api:v30`
- `ansonhui123/hk-bus-web:v16`
- `ansonhui123/hk-bus-eta-fetcher:v15-fix`
- `postgres:15`
- `grafana/grafana:latest`
