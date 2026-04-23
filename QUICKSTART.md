# Quick Start Guide

Get the HK Bus tracker running in 5 minutes on your local Kubernetes cluster.

---

## Prerequisites

✅ **macOS with Docker Desktop**
- Kubernetes enabled in Docker Desktop settings
- `kubectl` configured for `docker-desktop` context

```bash
# Verify
kubectl config current-context    # Should output: docker-desktop
kubectl get nodes                  # Should show 1 Ready node
```

---

## Step 1: Clone & Navigate

```bash
git clone https://github.com/Anson-1/hk-bus.git
cd hk-bus
```

---

## Step 2: Check Kubernetes Services

The system is already deployed. Verify all services are running:

```bash
kubectl get pods -n hk-bus
```

Expected output:
```
NAME                           READY   STATUS    RESTARTS
hk-bus-web-785f79df8b-gpfh4   1/1     Running   0
hk-bus-api-58fdbb55bf-nzqwv   1/1     Running   0
eta-fetcher-xxx-yyy            1/1     Running   0
postgres-0                      1/1     Running   0
```

---

## Step 3: Port Forward Services

Open **two terminal tabs** and run:

**Tab 1** (Web Frontend):
```bash
kubectl port-forward -n hk-bus svc/hk-bus-web 3000:80
```

**Tab 2** (Backend API):
```bash
kubectl port-forward -n hk-bus svc/hk-bus-api 3001:3001
```

---

## Step 4: Open Web App

**Browser**: http://localhost:3000

---

## Step 5: Search Route 91M

1. Type `91M` in the search box
2. Click 🔍 search button
3. Wait 2-3 seconds

---

## Expected Result

```
Route 91M
DIAMOND HILL STATION → PO LAM

Upcoming Stops (28)
1. TAI PO TSAI VILLAGE ⏱️ 11 min (24 samples)
2. NGAN YING ROAD ⏱️ 12 min (24 samples)
3. KING LAM ESTATE ⏱️ 13 min (24 samples)
...
28 stops total, all with real-time ETA data
```

The map shows all 28 stops as markers.

---

## Verify Data Collection

```bash
# Check eta-fetcher logs
kubectl logs -n hk-bus -l app=eta-fetcher --tail=10

# Check database
kubectl exec -it -n hk-bus postgres-0 -- \
  psql -U postgres -d hk_bus -c "SELECT COUNT(*) FROM eta_raw WHERE route='91M';"
```

---

## Troubleshooting

**No data showing?**
- Ensure both port-forwards are active (Step 3)
- Check `kubectl get pods -n hk-bus` - all Running?
- Reload page (Cmd+R)

**Only 12 stops?**
- Services outdated. Restart:
```bash
kubectl rollout restart deployment/hk-bus-api -n hk-bus
kubectl rollout restart deployment/eta-fetcher -n hk-bus
```

**Different ETAs each refresh?**
- Normal! Real data updates every 15 seconds.

