# 🚌 HK Bus Real-Time Tracker

**Status**: ✅ Running | **Route**: 91M | **Stops**: 29 | **Updates**: WebSocket real-time

Real-time ETA tracking for Hong Kong KMB Route 91M using Node.js, React, and Kubernetes.

---

## Quick Start (2 min)

**Prerequisites**: Docker Desktop with Kubernetes enabled

```bash
# Terminal 1: Port forward web app
kubectl port-forward -n hk-bus svc/hk-bus-web 8080:80

# Terminal 2: Port forward Grafana  
kubectl port-forward -n hk-bus svc/grafana 3000:3000

# Browser
open http://localhost:8080  # Web app - search "91M"
open http://localhost:3000  # Grafana dashboards
```

---

## Architecture

```
KMB API → eta-fetcher (cached) → PostgreSQL (indexed)
                                      ↓
                              Backend API (WebSocket)
                                      ↓
                          Frontend + Grafana (real-time)
```

---

## What's Running

| Component | Purpose | Tech |
|-----------|---------|------|
| **eta-fetcher** | Collects KMB data every 15s | Node.js, 80% API caching |
| **PostgreSQL** | Data storage | Indexed, <100ms queries |
| **Backend** | REST API + WebSocket | Express.js |
| **Frontend** | Web UI with map | React 18 + Vite |
| **Grafana** | Analytics dashboards | Live Route 91M metrics |

---

## Key Features

✅ **Real-time**: WebSocket push (<500ms latency)
✅ **Efficient**: 80% fewer API calls via caching
✅ **Fast queries**: <100ms with database indexes
✅ **Live data**: 29 stops with current ETAs
✅ **Interactive**: Leaflet map + stop list

---

## Common Commands

```bash
# System health
kubectl get pods -n hk-bus

# View logs
kubectl logs -n hk-bus -l app=eta-fetcher --tail=20

# Database access
kubectl exec -it postgres-0 -n hk-bus -- \
  psql -U postgres -d hkbus

# Restart service
kubectl rollout restart deployment/hk-bus-web -n hk-bus
```

---

## Troubleshooting

**No data in browser?**
```bash
kubectl rollout restart deployment/eta-fetcher -n hk-bus
```

**Port already in use?**
```bash
lsof -i :8080
# Note PID, then: kill <PID>
```

**Services not running?**
```bash
kubectl get pods -n hk-bus
kubectl describe pod <pod-name> -n hk-bus
```

---

## Documentation

- **[QUICKSTART.md](QUICKSTART.md)** - Step-by-step setup guide
- **[ARCHITECTURE.md](ARCHITECTURE.md)** - Technical deep dive
- **[DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)** - Production deployment
- **[SYSTEM_OVERVIEW.md](SYSTEM_OVERVIEW.md)** - Full system overview

---

## Tech Stack

Node.js | React | PostgreSQL | Kubernetes | Express.js | WebSocket | Grafana

---

**HKUST Course Project** | Route 91M Real-time Tracking | 29 Stops
