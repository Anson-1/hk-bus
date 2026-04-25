# Deployment Guide

Production setup for HK Bus tracking system.

---

## Prerequisites

- Docker installed
- Kubernetes cluster (Docker Desktop or KIND)
- kubectl configured
- ~10GB free disk space

---

## Deploy All Services

```bash
cd /Users/shiyangxu/Desktop/hk-bus

# Create namespace
kubectl create namespace hk-bus

# Deploy services
kubectl apply -f k8s/ -n hk-bus

# Wait for pods
kubectl get pods -n hk-bus -w
```

**Expected**: All pods RUNNING (eta-fetcher, postgres, hk-bus-web, grafana, etc.)

---

## Access Services

### Web App
```bash
# Port forward
kubectl port-forward -n hk-bus svc/hk-bus-web 8080:80

# Browser
open http://localhost:8080
```

### Grafana
```bash
# Port forward
kubectl port-forward -n hk-bus svc/grafana 3000:3000

# Browser
open http://localhost:3000
# Login: admin / admin
```

### Backend API
```bash
# Port forward
kubectl port-forward -n hk-bus svc/hk-bus-api 3001:3001

# Health check
curl http://localhost:3001/api/health
```

### PostgreSQL
```bash
kubectl exec -it postgres-0 -n hk-bus -- \
  psql -U postgres -d hkbus

# Query examples
SELECT COUNT(*) FROM eta_raw WHERE route='91M';
SELECT * FROM eta_raw LIMIT 5;
```

---

## Monitor System

```bash
# Pod status
kubectl get pods -n hk-bus

# View logs
kubectl logs -n hk-bus -l app=eta-fetcher --tail=20
kubectl logs -n hk-bus -l app=hk-bus-web --tail=20

# Resource usage
kubectl top pods -n hk-bus
```

---

## Database Statistics

```bash
# Raw data count
kubectl exec postgres-0 -n hk-bus -- \
  psql -U postgres -d hkbus -c \
  "SELECT COUNT(*) FROM eta_raw WHERE route='91M';"

# Latest records
kubectl exec postgres-0 -n hk-bus -- \
  psql -U postgres -d hkbus -c \
  "SELECT * FROM eta_raw WHERE route='91M' \
   ORDER BY fetched_at DESC LIMIT 5;"

# Data by hour
kubectl exec postgres-0 -n hk-bus -- \
  psql -U postgres -d hkbus -c \
  "SELECT DATE_TRUNC('hour', fetched_at) as hour, \
          COUNT(*) as count \
   FROM eta_raw \
   GROUP BY DATE_TRUNC('hour', fetched_at) \
   ORDER BY hour DESC LIMIT 24;"
```

---

## Troubleshooting

### Pod won't start

```bash
# Check pod status
kubectl describe pod <pod-name> -n hk-bus

# View logs
kubectl logs <pod-name> -n hk-bus --previous
```

### No data in database

```bash
# Check eta-fetcher is running
kubectl get pods -n hk-bus | grep eta-fetcher

# View logs
kubectl logs -n hk-bus -l app=eta-fetcher --tail=50
```

### Grafana shows "No data"

```bash
# Verify database has data
kubectl exec postgres-0 -n hk-bus -- \
  psql -U postgres -d hkbus -c "SELECT COUNT(*) FROM eta_raw;"

# Restart Grafana
kubectl rollout restart deployment grafana -n hk-bus
```

### API not responding

```bash
# Check backend status
kubectl get pods -n hk-bus | grep hk-bus-web

# View logs
kubectl logs -n hk-bus -l app=hk-bus-web --tail=50

# Restart
kubectl rollout restart deployment/hk-bus-web -n hk-bus
```

---

## Restart Services

```bash
# Restart all
kubectl rollout restart deployment -n hk-bus

# Restart specific service
kubectl rollout restart deployment/hk-bus-web -n hk-bus
kubectl rollout restart deployment/eta-fetcher -n hk-bus

# Restart database
kubectl delete pod postgres-0 -n hk-bus  # Force restart
```

---

## Update Images

```bash
# Build new image
docker build -f web-app/Dockerfile -t ansonhui123/hk-bus-web:v17 .

# Push to registry
docker push ansonhui123/hk-bus-web:v17

# Deploy
kubectl set image deployment/hk-bus-web \
  web=ansonhui123/hk-bus-web:v17 -n hk-bus

# Check rollout
kubectl rollout status deployment/hk-bus-web -n hk-bus
```

---

## Cleanup

```bash
# Delete entire namespace (removes all resources)
kubectl delete namespace hk-bus

# Or just delete deployments
kubectl delete deployment -n hk-bus --all
```

---

## Expected Performance

| Component | Metric | Status |
|-----------|--------|--------|
| **eta-fetcher** | 2,400+ records/cycle | ✅ |
| **PostgreSQL** | <100ms query time | ✅ |
| **Backend API** | <500ms response | ✅ |
| **WebSocket** | <500ms push latency | ✅ |
| **Grafana** | Data updates every 30s | ✅ |

---

## Quick Commands Reference

```bash
# Essential commands
kubectl get pods -n hk-bus
kubectl get svc -n hk-bus
kubectl logs -n hk-bus -l app=eta-fetcher --tail=20
kubectl describe pod <pod-name> -n hk-bus
kubectl port-forward -n hk-bus svc/grafana 3000:3000
kubectl rollout restart deployment/hk-bus-web -n hk-bus
kubectl exec -it postgres-0 -n hk-bus -- psql -U postgres -d hkbus
```
