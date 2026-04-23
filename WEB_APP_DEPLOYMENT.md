# Web App Deployment Guide

## Overview

The HK Bus Tracking System now includes:
- **Backend API**: Node.js/Express server connecting to PostgreSQL
- **Frontend**: React web app with real-time bus tracking
- **Kubernetes Deployment**: Deploy on the same cluster as the pipeline

## Architecture

```
┌─────────────────────────────────────┐
│  React Web App (Frontend)           │
│  ├─ Search bus stops                │
│  ├─ View ETAs on map                │
│  └─ Real-time bus info              │
└──────────────┬──────────────────────┘
               │ HTTP
       ┌───────▼────────┐
       │ Backend API    │
       │ (Node.js)      │
       └───────┬────────┘
               │ SQL
       ┌───────▼────────┐
       │ PostgreSQL     │
       └────────────────┘
```

## Local Development Setup

### Prerequisites
- Node.js 18+
- Docker & Docker Compose
- Running Kubernetes cluster with existing pipeline

### Option 1: Docker Compose (Easiest)

```bash
# From project root
docker-compose up --build

# Access:
# - Frontend: http://localhost:3000
# - Backend: http://localhost:3001/api/health
```

### Option 2: Manual Setup

**Backend:**
```bash
cd web-app/backend
npm install
npm start
# Runs on http://localhost:3001
```

**Frontend:**
```bash
cd web-app/frontend
npm install
npm run dev
# Runs on http://localhost:3000
```

## Build Docker Images

### Backend Image

```bash
cd web-app/backend
docker build -t ansonhui123/hk-bus-api:v1 .
docker push ansonhui123/hk-bus-api:v1
```

### Frontend Image

```bash
cd web-app/frontend
docker build -t ansonhui123/hk-bus-web:v1 .
docker push ansonhui123/hk-bus-web:v1
```

## Kubernetes Deployment

### 1. Deploy Backend API

```bash
kubectl apply -f k8s/backend-api-deployment.yaml

# Verify
kubectl get pods -l app=hk-bus-api -n hk-bus
kubectl logs -l app=hk-bus-api -n hk-bus
```

### 2. Deploy Frontend

```bash
kubectl apply -f k8s/frontend-deployment.yaml

# Verify
kubectl get pods -l app=hk-bus-web -n hk-bus
kubectl logs -l app=hk-bus-web -n hk-bus
```

### 3. Access the App

Get the LoadBalancer external IP:

```bash
kubectl get svc hk-bus-web -n hk-bus

# Then open your browser to:
# http://<EXTERNAL-IP>
```

For local development with port-forward:

```bash
kubectl port-forward svc/hk-bus-web 3000:80 -n hk-bus
# Open: http://localhost:3000
```

## API Endpoints

### Health Check
- **GET** `/api/health`
- Returns: `{ status: "ok", timestamp: "2026-04-23..." }`

### Search Bus Stops
- **GET** `/api/search?q={query}`
- Example: `/api/search?q=central`
- Returns: Array of matching stops with location data

### Get Bus Stop Details
- **GET** `/api/stops/{stopId}`
- Example: `/api/stops/001001`
- Returns: Stop location, name (Chinese/English)

### Get Real-time ETAs
- **GET** `/api/eta/{stopId}`
- Example: `/api/eta/001001`
- Returns: Incoming buses with wait times

### Get All Routes
- **GET** `/api/routes`
- Returns: List of all KMB routes

### Get Route Stops
- **GET** `/api/route/{route}/{direction}`
- Example: `/api/route/1/1`
- Returns: All stops for that route/direction

## Frontend Features

### Search Page
- Enter bus stop ID (e.g., "001001") or name (e.g., "Central Station")
- Auto-complete suggestions show stop name and ID
- Click to select a stop

### Bus Stop View
- **Map**: Interactive map showing the bus stop location
- **Incoming Buses**: List of buses coming to this stop
  - Shows route number and direction
  - Wait time in minutes
  - Delay status (⚠️ if delayed)
  - Sample count (how many data points)

## Environment Variables

**Backend** (k8s/backend-api-deployment.yaml):
```
DB_HOST=postgres-db.hk-bus.svc.cluster.local
DB_PORT=5432
DB_NAME=hk_bus
DB_USER=postgres
DB_PASSWORD=postgres
PORT=3001
NODE_ENV=production
```

**Frontend**: No configuration needed (auto-detects backend at http://localhost:3001)

## Troubleshooting

### Backend Pod Not Starting

```bash
# Check logs
kubectl logs deployment/hk-bus-api -n hk-bus

# Common issues:
# 1. Database connection - verify PostgreSQL is running
# 2. Image not found - ensure Docker image is pushed
# 3. Port already in use - check if another app uses port 3001
```

### Frontend Shows "No Data"

1. Check backend is running: `curl http://localhost:3001/api/health`
2. Check CORS is enabled (should be in server.js)
3. Search for a valid bus stop (e.g., try any 6-digit number)

### Map Not Showing

1. Check browser console for errors
2. Verify Leaflet CSS is loaded
3. Check stop has valid lat/long coordinates

## Performance Notes

- Frontend makes API calls in real-time (no caching)
- ETAs are updated every 1-5 seconds in production
- Backend queries PostgreSQL for latest aggregated data
- KMB API calls are cached by browser (3s default)

## Next Steps

1. **Build and push Docker images**
   ```bash
   docker build -t ansonhui123/hk-bus-api:v1 web-app/backend
   docker push ansonhui123/hk-bus-api:v1
   
   docker build -t ansonhui123/hk-bus-web:v1 web-app/frontend
   docker push ansonhui123/hk-bus-web:v1
   ```

2. **Deploy to Kubernetes**
   ```bash
   kubectl apply -f k8s/backend-api-deployment.yaml
   kubectl apply -f k8s/frontend-deployment.yaml
   ```

3. **Monitor the deployment**
   ```bash
   kubectl get all -n hk-bus
   kubectl logs -l app=hk-bus-api -n hk-bus
   kubectl logs -l app=hk-bus-web -n hk-bus
   ```

## References

- KMB ETABus API: https://data.etabus.gov.hk
- React Documentation: https://react.dev
- Vite Documentation: https://vitejs.dev
- Leaflet Map Library: https://leafletjs.com
