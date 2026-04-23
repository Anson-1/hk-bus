# Quick Commands Reference

## 🚀 START THE WEB APP

### Option 1: Access via Port-Forward (Easiest)
```bash
# Terminal 1: Start port-forward
kubectl port-forward svc/hk-bus-web 3000:80 -n hk-bus

# Then open in browser:
# http://localhost:3000
```

### Option 2: Direct Access (if LoadBalancer IP available)
```bash
# Get the IP
kubectl get svc hk-bus-web -n hk-bus

# Open in browser:
# http://<EXTERNAL-IP>
```

## 📡 TEST THE API

```bash
# Health check
curl http://localhost:3001/api/health

# Search for bus stops
curl "http://localhost:3001/api/search?q=001"

# Get all routes
curl http://localhost:3001/api/routes

# Get ETAs for a specific stop
curl http://localhost:3001/api/eta/001001
```

## 🔍 CHECK DEPLOYMENT STATUS

```bash
# All services in hk-bus namespace
kubectl get all -n hk-bus

# Backend API
kubectl get pods -l app=hk-bus-api -n hk-bus
kubectl logs -l app=hk-bus-api -n hk-bus

# Frontend Web
kubectl get pods -l app=hk-bus-web -n hk-bus
kubectl logs -l app=hk-bus-web -n hk-bus

# All services
kubectl get svc -n hk-bus
```

## 📊 MONITOR THE SYSTEM

```bash
# Watch all pod status
kubectl get pods -n hk-bus --watch

# Watch backend API
kubectl logs -f -l app=hk-bus-api -n hk-bus

# Watch frontend
kubectl logs -f -l app=hk-bus-web -n hk-bus

# Watch Spark pipeline
kubectl logs -f -l app=spark-streaming -n hk-bus

# Watch database
kubectl exec -it postgres-0 -n hk-bus -- psql -U postgres -d hk_bus
```

## 🔧 TROUBLESHOOTING

### Pod won't start
```bash
# Check pod status
kubectl describe pod <pod-name> -n hk-bus

# Check logs
kubectl logs <pod-name> -n hk-bus
```

### API returns errors
```bash
# Check if backend is healthy
curl http://localhost:3001/api/health

# Check database connection
kubectl exec -it hk-bus-api-<pod-id> -n hk-bus -- ps aux | grep node
```

### Frontend shows no data
```bash
# 1. Check backend is running
curl http://localhost:3001/api/health

# 2. Check browser console (F12)
# 3. Try searching for a different stop
# 4. Check API logs
kubectl logs -l app=hk-bus-api -n hk-bus | grep -i error
```

## 🔄 RESTART SERVICES

```bash
# Restart backend API
kubectl rollout restart deployment hk-bus-api -n hk-bus

# Restart frontend
kubectl rollout restart deployment hk-bus-web -n hk-bus

# Restart both
kubectl rollout restart deployment hk-bus-api hk-bus-web -n hk-bus
```

## 📈 SCALE REPLICAS

```bash
# Scale frontend to 3 replicas
kubectl scale deployment hk-bus-web --replicas=3 -n hk-bus

# Scale backend to 2 replicas
kubectl scale deployment hk-bus-api --replicas=2 -n hk-bus
```

## 🗄️ DATABASE QUERIES

```bash
# Connect to PostgreSQL
kubectl exec -it postgres-0 -n hk-bus -- psql -U postgres -d hk_bus

# Inside psql:

# See available tables
\dt

# Check ETAs for a specific stop
SELECT * FROM eta_realtime WHERE stop_id = '001001' ORDER BY window_start DESC LIMIT 10;

# See latest data
SELECT DISTINCT route, dir, COUNT(*) FROM eta_realtime GROUP BY route, dir;

# Check data volume
SELECT COUNT(*) FROM eta_raw;
SELECT COUNT(*) FROM eta_realtime;
```

## 🚢 DEPLOY NEW VERSIONS

```bash
# Build new backend image
cd web-app/backend
docker build -t ansonhui123/hk-bus-api:v2 .
docker push ansonhui123/hk-bus-api:v2

# Update deployment
kubectl set image deployment/hk-bus-api hk-bus-api=ansonhui123/hk-bus-api:v2 -n hk-bus

# Similar for frontend
cd ../frontend
docker build -t ansonhui123/hk-bus-web:v2 .
docker push ansonhui123/hk-bus-web:v2
kubectl set image deployment/hk-bus-web web=ansonhui123/hk-bus-web:v2 -n hk-bus
```

## 📚 LOCAL DEVELOPMENT

```bash
# Using Docker Compose
docker-compose up --build

# Manual setup
# Terminal 1: Backend
cd web-app/backend
npm install
npm start

# Terminal 2: Frontend
cd web-app/frontend
npm install
npm run dev

# Access at http://localhost:3000
```

## 🧹 CLEANUP

```bash
# Delete deployments
kubectl delete deployment hk-bus-api hk-bus-web -n hk-bus

# Delete services
kubectl delete svc hk-bus-api hk-bus-web -n hk-bus

# Delete everything in namespace (careful!)
kubectl delete all --all -n hk-bus
```

## 📝 USEFUL KUBECTL ALIASES

```bash
# Add to ~/.bashrc or ~/.zshrc
alias k='kubectl'
alias kgp='kubectl get pods'
alias kgpa='kubectl get pods -n hk-bus'
alias kl='kubectl logs'
alias klf='kubectl logs -f'
alias kd='kubectl describe'
alias ke='kubectl exec -it'

# Example usage:
# kgpa                          # Get all pods in hk-bus
# klf -l app=hk-bus-api        # Follow logs of backend
# ke postgres-0 -- psql ...    # Connect to database
```

## 🎯 COMMON WORKFLOWS

### Check if everything is working
```bash
echo "Checking deployment status..."
kubectl get pods -n hk-bus
echo ""
echo "Checking services..."
kubectl get svc -n hk-bus
echo ""
echo "Testing API health..."
curl http://localhost:3001/api/health
echo ""
echo "All systems operational!"
```

### Deploy the latest code
```bash
# Backend
cd web-app/backend
docker build -t ansonhui123/hk-bus-api:latest .
docker push ansonhui123/hk-bus-api:latest
kubectl rollout restart deployment hk-bus-api -n hk-bus

# Frontend
cd ../frontend
docker build -t ansonhui123/hk-bus-web:latest .
docker push ansonhui123/hk-bus-web:latest
kubectl rollout restart deployment hk-bus-web -n hk-bus

# Verify
kubectl get pods -n hk-bus
```

### Full system backup
```bash
# Export current state
kubectl get all -n hk-bus -o yaml > hk-bus-backup.yaml

# Export database schema
kubectl exec postgres-0 -n hk-bus -- pg_dump -U postgres -d hk_bus > hk-bus-db.sql
```

---

**Need help?** Read the full documentation in WEB_APP_README.md or WEB_APP_DEPLOYMENT.md
