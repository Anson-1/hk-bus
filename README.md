# HK Bus Real-Time ETA Tracker

A real-time Hong Kong KMB bus tracking system built as an HKUST course project. Features live bus arrival times, interactive map, and Kubernetes deployment.

**Live Status**: ✅ Route 91M (PO LAM ↔ DIAMOND HILL) - 28 stops with real-time ETA data

---

## Quick Start (2 minutes)

### Prerequisites
- macOS with Docker Desktop (Kubernetes enabled)
- `kubectl` configured for `docker-desktop` context
- Port 3000, 3001, 3002 available

### Run
```bash
# Start port forwards
kubectl port-forward -n hk-bus svc/hk-bus-web 3000:80 &
kubectl port-forward -n hk-bus svc/hk-bus-api 3001:3001 &

# Open browser
open http://localhost:3000

# Search for Route 91M and see live ETAs
```

**Expected**: 28 bus stops with real arrival times (11-37 minutes)

---

## Features

### Real-Time Data Collection
- **eta-fetcher** (Node.js service in K8s)
  - Polls KMB API every 15 seconds
  - Fetches 28 stops per direction
  - ~2,400 ETA records inserted per cycle
  - Validates and stores in PostgreSQL

### Backend API
- **Express.js REST API**
  - `/api/route/:routeNum` - Get all stops with ETAs
  - `/api/health` - Service health check
  - Aggregates ETA data (last 2 minutes window)
  - Batched stop detail fetching (5 parallel)

### Frontend Web App
- **React + Vite**
  - Real-time route search
  - Interactive Leaflet map with 28 markers
  - Stop list sorted by arrival time
  - Stop names in English/Chinese
  - Sample counts for data quality

### Data Storage
- **PostgreSQL**
  - `eta_raw` table: 2,400+ records per cycle
  - Stores: route, direction, stop_id, wait_sec, sample_count
  - 2-minute aggregation window for freshness

---

## System Architecture

```
KMB ETABus API
    ↓
┌────────────────────────────────────┐
│  eta-fetcher (Node.js K8s pod)     │
│  • Every 15s: fetch Route 91M      │
│  • 28 stops × 2 directions         │
│  • Calculate wait times            │
└────────────────────────────────────┘
    ↓ (insert)
┌────────────────────────────────────┐
│  PostgreSQL (eta_raw table)        │
│  • 2,400+ records per cycle        │
│  • Real-time ETA data              │
└────────────────────────────────────┘
    ↑ (query & aggregate)
┌────────────────────────────────────┐
│  Backend API (Express.js)          │
│  • /api/route/91M endpoint         │
│  • Aggregates last 2 minutes       │
│  • Returns 28 stops with ETAs      │
└────────────────────────────────────┘
    ↑ (REST)
┌────────────────────────────────────┐
│  Frontend (React + Leaflet)        │
│  • Interactive map                 │
│  • Stop list sorted by ETA         │
│  • Real-time updates               │
└────────────────────────────────────┘
```

---

## Route 91M Details

**Direction**: Inbound (DIAMOND HILL → PO LAM)  
**Service Type**: 1  
**Total Stops**: 28  
**Sample Size**: 10+ samples per stop  
**ETA Range**: 11-37 minutes  

### Sample Stops
1. TAI PO TSAI VILLAGE (11 min)
2. NGAN YING ROAD (12 min)
3. KING LAM ESTATE (13 min)
...
12. H.K.U.S.T. (NORTH) (20 min) ← **HKUST Campus**
...
28. NGAU CHI WAN BBI (37 min)

---

## Technical Stack

| Component | Technology |
|-----------|-----------|
| Data Collection | Node.js (eta-fetcher) |
| Backend API | Express.js (Node.js) |
| Frontend | React 18 + Vite |
| Mapping | Leaflet + OpenStreetMap |
| Database | PostgreSQL 14 |
| Container | Docker + Kubernetes |
| Orchestration | kubectl (Kubernetes) |

---

## Development

### Check Data in Database
```bash
# Connect to PostgreSQL
kubectl exec -it -n hk-bus postgres-0 -- \
  psql -U postgres -d hk_bus

# Query 91M data
SELECT route, dir, COUNT(*) as count FROM eta_raw 
WHERE route = '91M' GROUP BY route, dir;
```

### View API Response
```bash
# From inside cluster
kubectl exec -it -n hk-bus deployment/hk-bus-web -- \
  curl -s http://hk-bus-api.hk-bus.svc.cluster.local:3001/api/route/91M | jq '.stops[0:3]'
```

### Check eta-fetcher Logs
```bash
kubectl logs -n hk-bus -l app=eta-fetcher --tail=50
```

Expected output:
```
✓ Got 28 stops for Route 91M(inbound)
✓ Got 29 stops for Route 91M(outbound)
✅ Fetch cycle complete - Processed: 2400, Inserted: 2400, Errors: 0
```

---

## Deployment

### Images
- `ansonhui123/hk-bus-eta-fetcher:v13` - ETA data collection service
- `ansonhui123/hk-bus-api:v22` - Backend REST API
- `ansonhui123/hk-bus-web:v11` - Frontend web app

### Services
- **hk-bus-web**: LoadBalancer on port 80 (frontend)
- **hk-bus-api**: ClusterIP on port 3001 (backend)
- **postgres**: StatefulSet with persistent storage
- **eta-fetcher**: Deployment with 1 replica

---

## Troubleshooting

### "Failed to fetch route details"
**Cause**: Web app can't reach backend when port-forwarded  
**Solution**: Ensure both port-forwards are active:
```bash
kubectl port-forward -n hk-bus svc/hk-bus-web 3000:80 &
kubectl port-forward -n hk-bus svc/hk-bus-api 3001:3001 &
```

### No stops showing
**Cause**: eta-fetcher not running or no data collected  
**Check**: 
```bash
kubectl get pods -n hk-bus | grep eta-fetcher
kubectl logs -n hk-bus -l app=eta-fetcher
```

### Wrong stop order
**Cause**: Data sorting is by wait time, not sequence  
**Expected**: Stops are ordered by estimated arrival (shortest first)

---

## Project Structure

```
hk-bus/
├── k8s/
│   ├── eta-fetcher/
│   │   ├── Dockerfile
│   │   └── server.js (v13)
│   ├── postgres/
│   │   ├── deployment.yaml
│   │   └── init.sql
│   └── ...
├── web-app/
│   ├── backend/
│   │   ├── Dockerfile
│   │   └── server.js (v22)
│   ├── frontend/
│   │   ├── Dockerfile
│   │   ├── nginx.conf
│   │   └── src/
│   │       ├── components/
│   │       │   ├── SearchBar.jsx
│   │       │   └── RouteDetailsView.jsx
│   │       └── ...
│   └── ...
├── README.md (this file)
├── QUICKSTART.md (detailed setup)
└── ARCHITECTURE.md (technical design)
```

---

## Notes

- Route 91M is the primary focus (HKUST course project)
- System currently tracks only Route 91M (can be extended)
- Data retention: Last 2 minutes for real-time, can be expanded
- ETA accuracy depends on KMB API data quality

---

## Course Context

**Course**: HKUST Computer Science  
**Focus**: Route 91M (serves HKUST campus)  
**Technologies**: Node.js, React, PostgreSQL, Kubernetes  
**Real-World Application**: Live bus tracking system  

---

## Next Steps

- [ ] Add other routes (Route 1, 2, etc.)
- [ ] Historical trend analysis
- [ ] Route comparison view
- [ ] Mobile app version
- [ ] Notification alerts (bus arriving soon)
