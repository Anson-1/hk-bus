# Quick Start Guide

Get HK Bus tracker running in 5 minutes.

---

## Prerequisites

✅ Docker Desktop (Kubernetes enabled)
✅ kubectl installed
✅ `kubectl config current-context` shows `docker-desktop`

```bash
# Verify
kubectl get nodes
```

---

## Step 1: Port Forward

Open **two terminals**:

**Terminal 1** (Web App):
```bash
kubectl port-forward -n hk-bus svc/hk-bus-web 8080:80
```

**Terminal 2** (Grafana):
```bash
kubectl port-forward -n hk-bus svc/grafana 3000:3000
```

---

## Step 2: Open Browser

```bash
open http://localhost:8080
```

---

## Step 3: Search Route 91M

Type `91M` in search box → Click search

---

## Expected Result

```
Route 91M - PO LAM to DIAMOND HILL

Upcoming Stops (29):
  1. PO LAM BUS TERMINUS - 0 min (1 sample)
  2. YAN KING ROAD - 0 min (1 sample)
  3. KING LAM ESTATE - 1 min (1 sample)
  ...
  6. HANG HAU STATION - 6 min (1 sample)
  ...
  13. H.K.U.S.T. (SOUTH) - 9 min (1 sample)
  ...
  29. DIAMOND HILL STATION - 21 min (1 sample)
```

**Map** shows all 29 stops as markers.

Data updates automatically every 15 seconds via WebSocket (no manual refresh).

---

## Verify It's Working

```bash
# Check all pods are running
kubectl get pods -n hk-bus

# View eta-fetcher logs (collecting data)
kubectl logs -n hk-bus -l app=eta-fetcher --tail=10

# Check database
kubectl exec -it postgres-0 -n hk-bus -- \
  psql -U postgres -d hkbus -c "SELECT COUNT(*) FROM eta_raw WHERE route='91M';"
```

---

## Grafana Dashboard

Open: http://localhost:3000 (admin / admin)

Available dashboards:
- Route 91M - Real-time Analytics (live metrics)
- (Others may show "No data" if only testing 91M)

---

## Common Issues

| Issue | Solution |
|-------|----------|
| Port 8080 already in use | `lsof -i :8080` then kill PID |
| "Failed to fetch route details" | Restart: `kubectl rollout restart deployment/hk-bus-web -n hk-bus` |
| No data showing | Wait 15-30 sec for first data collection cycle |
| Page doesn't auto-update | Check browser console for WebSocket errors |

---

## Troubleshoot Pods

```bash
# Check pod status
kubectl describe pod <pod-name> -n hk-bus

# View logs
kubectl logs <pod-name> -n hk-bus --tail=50

# Restart pod
kubectl rollout restart deployment/<deployment-name> -n hk-bus
```

---

## Next Steps

- See [ARCHITECTURE.md](ARCHITECTURE.md) for technical details
- See [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) for production setup
- See [SYSTEM_OVERVIEW.md](SYSTEM_OVERVIEW.md) for full system architecture
