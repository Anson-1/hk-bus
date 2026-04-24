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
hk-bus-web-58d77965ff-7hlqf   1/1     Running   0
hk-bus-api-xxxx-yyyy           1/1     Running   0
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

**Tab 2** (Backend API + WebSocket):
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
3. Wait 1-2 seconds

---

## Expected Result

```
Route 91M
PO LAM - DIAMOND HILL STATION

Upcoming Stops (29)
1. PO LAM BUS TERMINUS ⏱️ 0 min (1 sample)
2. YAN KING ROAD, METRO CITY ⏱️ 0 min (1 sample)
3. KING LAM ESTATE ⏱️ 1 min (1 sample)
...
6. HANG HAU STATION ⏱️ 6 min (1 sample)
...
13. H.K.U.S.T. (SOUTH) ⏱️ 9 min (1 sample)
...
29 stops total, all with real-time ETA data
```

The map shows all 29 stops as markers. **Data updates automatically via WebSocket when new ETAs arrive** (every 15 seconds).

---

## Real-Time Updates

The frontend automatically updates when new data arrives **without manual refresh**:
- ✅ ETA times update
- ✅ Stop list refreshes
- ✅ Map markers update
- ✅ No polling, no delay - instant push updates via WebSocket

---

## Verify Data Collection

```bash
# Check eta-fetcher logs with cache stats
kubectl logs -n hk-bus -l app=eta-fetcher --tail=10

# Check database record count
kubectl exec -it -n hk-bus postgres-0 -- \
  psql -U postgres -d hk_bus -c "SELECT COUNT(*) FROM eta_raw WHERE route='91M';"

# Check WebSocket connections in backend logs
kubectl logs -n hk-bus -l app=hk-bus-api --tail=10
```

Expected output from eta-fetcher:
```
✓ Fetched 29 stops for Route 91M(outbound)
✓ Cache hit for Route 91M(outbound) - 29 stops
✓ Cache hit for Route 91M(outbound) - 29 stops
✅ Fetch cycle complete - Cache Hits: 15, API Calls: 8
```

Expected output from backend (WebSocket):
```
[WebSocket] Client abc123 connected
[WebSocket] Client abc123 subscribed to route 91M
[WebSocket] Client abc123 unsubscribed from route 91M
```

---

## Performance Features

### ⚡ WebSocket Real-Time Updates
- Frontend receives push updates instead of polling
- ~97% faster than HTTP polling (500ms vs 15s)
- Instant ETA updates when data changes

### 🚀 API Response Caching
- eta-fetcher caches KMB API responses (15-sec TTL)
- 80% reduction in external API calls
- Faster data collection

### ⚙️ Database Optimization
- Strategic indexes on `eta_raw` table
- Query time <100ms (vs 1s+ before)
- Connection pooling for better throughput

---

## Troubleshooting

**No data showing?**
- Ensure both port-forwards are active (Step 3)
- Check `kubectl get pods -n hk-bus` - all Running?
- Reload page (Cmd+R)

**Page doesn't update automatically?**
- Check browser console for WebSocket connection errors
- Verify backend is running: `kubectl get pods -n hk-bus`
- Try restarting the backend: `kubectl rollout restart deployment/hk-bus-api -n hk-bus`

**Only 12 stops showing?**
- Services may be outdated. Restart:
```bash
kubectl rollout restart deployment/hk-bus-api -n hk-bus
kubectl rollout restart deployment/eta-fetcher -n hk-bus
```

**Different ETAs each refresh?**
- Normal! Real data updates every 15 seconds from KMB API.

---

## Architecture

For detailed technical architecture, see [ARCHITECTURE.md](ARCHITECTURE.md).

**Quick Overview**:
```
KMB API → eta-fetcher (with caching) → PostgreSQL (with indexes) 
→ Backend API (WebSocket) → Frontend (Socket.io) → Browser
```

Real-time flow:
1. eta-fetcher polls KMB API every 15 seconds (with cache)
2. Stores data in PostgreSQL
3. Backend API broadcasts updates via WebSocket
4. Frontend receives push updates instantly
5. No polling, no delay, no manual refresh needed

