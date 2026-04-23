# HK Bus Tracker - Web App

Complete React + Node.js web application for real-time Hong Kong bus tracking.

## 🎯 Features

- **🔍 Bus Stop Search**: Search by stop ID or name (Chinese/English)
- **🗺️ Interactive Map**: View bus stops on an OpenStreetMap-based map
- **⏱️ Real-time ETAs**: See incoming buses with wait times
- **⚠️ Delay Alerts**: Visual indicators for delayed buses
- **📊 Data-driven**: Connected to Kafka → Spark → PostgreSQL pipeline

## 🏗️ Architecture

```
┌─────────────────────────────────────┐
│    React Web App (Port 3000)        │
│  ├─ Search & auto-complete         │
│  ├─ Interactive map (Leaflet)       │
│  └─ Real-time ETA display           │
└──────────────┬──────────────────────┘
               │ HTTP/REST
       ┌───────▼────────┐
       │  Node.js API   │ (Port 3001)
       │ (Express.js)   │
       └───────┬────────┘
               │ SQL
       ┌───────▼────────┐
       │  PostgreSQL    │
       │ (Real-time)    │
       └────────────────┘
```

## 📦 Components

### Backend (Node.js + Express)
- Location: `web-app/backend/`
- Port: 3001
- Database: PostgreSQL (hk_bus)
- API: RESTful endpoints for bus data

### Frontend (React + Vite)
- Location: `web-app/frontend/`
- Port: 3000
- Build Tool: Vite
- Map: Leaflet.js

## 🚀 Quick Start

### Option 1: Local Development

```bash
# Terminal 1: Backend
cd web-app/backend
npm install
npm start
# Runs on http://localhost:3001

# Terminal 2: Frontend
cd web-app/frontend
npm install
npm run dev
# Runs on http://localhost:3000
```

### Option 2: Docker Compose

```bash
docker-compose up --build

# Access:
# Frontend: http://localhost:3000
# Backend: http://localhost:3001/api/health
```

### Option 3: Kubernetes (Production)

```bash
# Deploy
kubectl apply -f k8s/backend-api-deployment.yaml
kubectl apply -f k8s/frontend-deployment.yaml

# Access via port-forward
kubectl port-forward svc/hk-bus-web 3000:80 -n hk-bus
# Open: http://localhost:3000
```

## 📡 API Endpoints

### Health Check
```
GET /api/health
```
Response:
```json
{
  "status": "ok",
  "timestamp": "2026-04-23T01:16:46.108Z"
}
```

### Search Bus Stops
```
GET /api/search?q={query}
```
Example: `GET /api/search?q=central`

Response:
```json
{
  "query": "central",
  "results": [
    {
      "stop_id": "001001",
      "name_en": "Central Station",
      "name_tc": "中環站",
      "lat": 22.2856,
      "long": 114.1575
    }
  ],
  "count": 1
}
```

### Get Stop Details
```
GET /api/stops/{stopId}
```
Example: `GET /api/stops/001001`

Response:
```json
{
  "stop_id": "001001",
  "name_en": "Central Station",
  "name_tc": "中環站",
  "lat": 22.2856,
  "long": 114.1575
}
```

### Get Real-time ETAs
```
GET /api/eta/{stopId}
```
Example: `GET /api/eta/001001`

Response:
```json
{
  "stop": {
    "stop_id": "001001",
    "name_en": "Central Station",
    "name_tc": "中環站",
    "lat": 22.2856,
    "long": 114.1575
  },
  "etas": [
    {
      "route": "1",
      "dir": "1",
      "wait_sec": 480,
      "sample_count": 3,
      "window_start": "2026-04-23T01:10:00",
      "avg_delay_flag": 0
    }
  ],
  "count": 1,
  "timestamp": "2026-04-23T01:16:46.108Z"
}
```

### Get All Routes
```
GET /api/routes
```

### Get Route Stops
```
GET /api/route/{route}/{direction}
```
Example: `GET /api/route/1/1`

## 🎨 UI Components

### SearchBar
- Auto-complete suggestions from KMB API
- Handles Chinese and English input
- Click to select a stop

### MapDisplay
- Leaflet-based interactive map
- Shows bus stop location with marker
- Zoom/pan controls
- Popup showing stop details

### BusStopView
- Displays selected stop information
- Lists incoming buses
- Shows wait times in minutes
- Delay indicators for delayed buses
- Sample count statistics

## 🔧 Configuration

### Backend Environment Variables
```env
DB_HOST=postgres-db.hk-bus.svc.cluster.local
DB_PORT=5432
DB_NAME=hk_bus
DB_USER=postgres
DB_PASSWORD=postgres
PORT=3001
NODE_ENV=production
KMB_API_BASE=https://data.etabus.gov.hk/v1/transport/kmb
```

### Frontend Configuration
- API endpoint: Configured to hit `http://localhost:3001`
- Can be customized in components

## 📊 Data Flow

1. User enters bus stop in search box
2. Frontend queries `/api/search` for matches
3. User selects a stop
4. Frontend fetches:
   - Stop details from `/api/stops/:stopId`
   - Real-time ETAs from `/api/eta/:stopId`
5. Map displays stop location (Leaflet)
6. ETA list shows incoming buses with wait times
7. Data refreshes every 5 seconds

## 🐳 Docker Images

### Backend Image
- **Name**: `ansonhui123/hk-bus-api:v1`
- **Size**: ~200MB
- **Base**: node:18-alpine

### Frontend Image
- **Name**: `ansonhui123/hk-bus-web:v1`
- **Size**: ~50MB
- **Base**: node:18-alpine (build), nginx (runtime)

## 🧪 Testing

### Test Backend Locally
```bash
curl http://localhost:3001/api/health
curl "http://localhost:3001/api/search?q=001"
curl http://localhost:3001/api/routes
```

### Test Frontend
1. Open http://localhost:3000
2. Search for "001" or any bus stop
3. Click on result
4. View map and ETAs

## 📝 File Structure

```
web-app/
├── backend/
│   ├── server.js              # Express API server
│   ├── package.json           # Dependencies
│   ├── .env                   # Environment config
│   └── Dockerfile             # Docker build
├── frontend/
│   ├── src/
│   │   ├── App.jsx            # Main component
│   │   ├── App.css            # Styles
│   │   ├── main.jsx           # Entry point
│   │   └── components/
│   │       ├── SearchBar.jsx  # Search component
│   │       ├── BusStopView.jsx# ETA display
│   │       └── MapDisplay.jsx # Map component
│   ├── index.html             # HTML template
│   ├── vite.config.js         # Vite config
│   ├── package.json           # Dependencies
│   └── Dockerfile             # Docker build
└── README.md                  # This file
```

## 🔐 Security Considerations

- CORS enabled for API access
- Environment variables for sensitive data
- Database credentials in Kubernetes Secrets (recommended for production)
- Input validation on search queries
- Rate limiting recommended for production

## 📈 Performance

- Frontend: ~337KB bundle (gzipped: ~107KB)
- Backend: ~200MB Docker image
- API response time: <100ms (typical)
- Database queries: Optimized with indexes
- Real-time updates: 5-second refresh interval

## 🐛 Troubleshooting

### Backend Won't Connect to Database
```bash
# Check PostgreSQL is running
kubectl exec postgres-0 -n hk-bus -- psql -U postgres -d hk_bus -c "SELECT 1;"

# Check logs
kubectl logs -l app=hk-bus-api -n hk-bus
```

### Frontend Shows "No Data"
1. Verify backend is running: `curl http://localhost:3001/api/health`
2. Check browser console for errors (F12)
3. Try searching for a valid stop ID (e.g., "001001")
4. Check CORS is enabled in backend

### Map Not Rendering
1. Clear browser cache
2. Check Leaflet CSS is loaded: `curl http://localhost:3000`
3. Verify coordinates are valid (lat/long)

## 🚀 Deployment Checklist

- [ ] Build Docker images: `docker build -t ... .`
- [ ] Push to registry: `docker push ...`
- [ ] Update image tags in Kubernetes YAMLs
- [ ] Deploy backend: `kubectl apply -f k8s/backend-api-deployment.yaml`
- [ ] Deploy frontend: `kubectl apply -f k8s/frontend-deployment.yaml`
- [ ] Verify pods are running: `kubectl get pods -n hk-bus`
- [ ] Test API endpoints
- [ ] Check frontend loads: `kubectl port-forward svc/hk-bus-web 3000:80 -n hk-bus`
- [ ] Search for a bus stop and verify ETAs display

## 📚 References

- [React Documentation](https://react.dev)
- [Express.js Guide](https://expressjs.com)
- [Vite Build Tool](https://vitejs.dev)
- [Leaflet Maps](https://leafletjs.com)
- [KMB ETABus API](https://data.etabus.gov.hk)
- [PostgreSQL Docs](https://www.postgresql.org/docs/)

## 📄 License

This project is part of the HK Bus Real-time ETA Tracking System.

## 👥 Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Submit a pull request

---

**Status**: ✅ Production Ready

Last Updated: 2026-04-23
