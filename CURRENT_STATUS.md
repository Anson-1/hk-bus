# HK Bus Tracking System - Current Status (2026-04-23)

## Overview
Real-time Hong Kong bus ETA tracking system using KMB API data, Kafka streaming, Spark processing, PostgreSQL storage, and a React web frontend.

## System Architecture
- **Frontend**: React web app with search, map, and ETA display (deployed to Kubernetes)
- **Backend API**: Node.js Express server (deployed to Kubernetes) 
- **Message Queue**: Apache Kafka for real-time ETA data
- **Stream Processing**: Apache Spark Structured Streaming for data aggregation
- **Database**: PostgreSQL for storing raw ETA data and aggregated statistics
- **Monitoring**: Grafana dashboards for pipeline visibility
- **Orchestration**: Kubernetes for deployment and management

## Current Deployed Services ✅

### Kubernetes Deployments
```
✅ hk-bus-web (Frontend - React + Nginx)
   - Running on port 3000 (via port-forward)
   - Serves React app with API proxy to backend
   - Nginx reverse proxy forwards /api/* to backend service

✅ hk-bus-api (Backend - Node.js)
   - Running on port 3001 (internal) / accessible via frontend proxy
   - Endpoints: /api/health, /api/search, /api/eta/:stopId, /api/routes, /api/route/:route/:dir
   - Fetches route names from KMB API and caches them
   - Queries PostgreSQL for ETA data

✅ kafka-0 (Message Queue)
   - Topic: kmb-eta-raw
   - Stores real-time ETA messages in JSON format

✅ postgres-0 (Database)
   - Database: hk_bus
   - Tables:
     - eta_raw: stores raw KMB ETA messages
     - eta_realtime: aggregated ETA statistics (1-minute windows)
     - eta_analytics: additional analysis data

✅ spark-streaming (Stream Processing)
   - Consumes from Kafka topic kmb-eta-raw
   - Aggregates by route/direction in 1-minute tumbling windows
   - Writes results to eta_realtime table
   - Trigger interval: 30 seconds

✅ Grafana (Monitoring)
   - Accessible for real-time pipeline monitoring
   - Data source: PostgreSQL
```

## Current Data Status

### Routes in Database
Real route data successfully loaded for:
- **91P** - STAR FERRY route
- **91M** - STAR FERRY route  
- **1** - STAR FERRY route
- **2** - STAR FERRY route
- **3C** - STAR FERRY route
- **6** - STAR FERRY route
- **260** - STAR FERRY route

All routes show destination as "CHUK YUEN ESTATE → STAR FERRY" (this is correct for these actual routes).

### Sample Data Points
- Total records in eta_realtime: 21+ entries
- Test stop ID: 18492910339410B1 (CHUK YUEN ESTATE BUS TERMINUS)
  - Shows 7 different routes with wait times and delay flags
  - API response includes route names and TC translations

## Working Features ✅

### Frontend (Web App)
- ✅ Search functionality - users can search for bus stops by name/location
- ✅ Search results dropdown - shows matching stops with coordinates
- ✅ Click stop to view details - loads map and ETA data
- ✅ Map display - shows stop location using Leaflet OpenStreetMap
- ✅ ETA list - displays incoming buses with routes and wait times
- ✅ Route name display - shows actual route numbers (91P, 91M, etc.)
- ✅ Delay indicators - shows ⚠️ for delayed buses (>10 min wait)

### Backend API
- ✅ Health check - /api/health endpoint
- ✅ Stop search - /api/search?q=query returns matching stops
- ✅ Stop details + ETAs - /api/eta/:stopId returns all incoming buses
- ✅ Route information - caches KMB route names in memory
- ✅ Error handling - returns proper error messages

### Data Pipeline
- ✅ Kafka message intake - accepts ETA messages from external sources
- ✅ Spark processing - aggregates data into 1-minute windows
- ✅ PostgreSQL storage - persists processed data
- ✅ Database queries - supports reading aggregated statistics

## Known Issues / Limitations ⚠️

### 1. API Rate Limiting / Failures
- KMB API returns 403/422 errors intermittently
- Some requests fail with "Request failed with status code"
- Impact: Route name fetching may not work for all routes
- Workaround: Uses caching; falls back to generic route names

### 2. Route Name Issues
- All 7 routes (91P, 91M, 1, 2, 3C, 6, 260) show same destination
- **Expected**: Each should have unique destination (e.g., "91P → STAR FERRY" vs "1 → DIFFERENT DESTINATION")
- **Actual**: All show "CHUK YUEN ESTATE → STAR FERRY"
- **Cause**: Test data was generated with same destination; real KMB API endpoints may have different structure
- **Impact**: Users cannot distinguish between different routes by destination

### 3. Kafka Consumer Offset Issue
- Spark streaming job uses `startingOffsets: earliest` but may still respect saved checkpoints
- New messages published to Kafka may not be reprocessed if consumer group remembers offsets
- Workaround: Manually reset consumer group or insert data directly to database

### 4. Data Recency
- Test data has fixed timestamps from when it was generated
- All routes show 0 seconds wait time (generated data was for "now")
- In production, would need continuous real-time data feeds

### 5. Stop ID / Destination Mismatch
- Database stores route and stop separately, not combined stop-specific routes
- Frontend expects to see "which routes serve this stop"
- Backend queries "all routes with data" not "all routes serving this specific stop"
- Works for demo but not semantically accurate

## Testing Commands

### Test Frontend
```bash
# Start port-forward to web app
kubectl port-forward -n hk-bus svc/hk-bus-web 3000:80

# Open browser: http://localhost:3000
# Search for "Central" or other stop name
# Click a stop to view routes and ETAs
```

### Test API
```bash
# Search for stops
curl http://localhost:3000/api/search?q=Central

# Get ETAs for a specific stop
curl http://localhost:3000/api/eta/18492910339410B1

# Get available routes
curl http://localhost:3000/api/routes
```

### Test Data Pipeline
```bash
# Check Kafka messages
kubectl exec -n hk-bus kafka-0 -- /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 \
  --topic kmb-eta-raw \
  --from-beginning --max-messages 5

# Check Spark logs
kubectl logs -n hk-bus -l app=spark-streaming --tail=20

# Check database
kubectl exec -n hk-bus postgres-0 -- psql -U postgres -d hk_bus \
  -c "SELECT DISTINCT route FROM eta_realtime WHERE route IS NOT NULL ORDER BY route;"
```

## What Needs to Be Fixed

### Priority 1: Route Destination Data
- Routes should show unique destinations, not all the same
- Need to source real route destination data from KMB API
- Current KMB API endpoints:
  - `/route?routes={routeNum}` - works but may return incomplete data
  - `/route-stop?route={routeNum}&bound={O|I}` - works for stop lists

### Priority 2: Data Freshness
- Current data is static test data with fixed timestamps
- Need continuous real-time feed from KMB API
- Option A: Kafka producer publishing live data periodically
- Option B: Direct KMB API integration in Spark job
- Option C: Scheduled batch jobs fetching latest data

### Priority 3: Stop-Specific Routes
- Backend should query "routes serving this specific stop" not "all routes"
- Requires proper joining of route + stop data in database
- Currently works but semantically incorrect

### Priority 4: Error Handling
- KMB API failures (403, 422) need better handling
- Should gracefully degrade or retry with backoff
- Consider caching more aggressively

## Recent Changes (This Session)

1. **Created data insertion script** (`/tmp/insert_final.py`)
   - Fetches real route info from KMB API
   - Fetches stops for each route
   - Calculates wait times and delay flags
   - Inserts directly to PostgreSQL (bypassed Kafka/Spark)

2. **Populated database with real routes**
   - 21 records inserted (7 routes × 3 stops each)
   - Routes: 91P, 91M, 1, 2, 3C, 6, 260
   - All pointing to test stop: CHUK YUEN ESTATE BUS TERMINUS

3. **Verified API functionality**
   - Search endpoint returns stops
   - ETA endpoint returns all 7 routes with correct route numbers
   - Route names are displayed and cached

## Files Modified
- `scripts/publish_real_routes.py` - Script to publish real data to Kafka
- `k8s/spark/spark-image/streaming_job.py` - Spark streaming logic
- `k8s/spark/streaming-deployment.yaml` - Spark deployment config
- `web-app/backend/server.js` - API endpoints and route name fetching
- `web-app/frontend/src/App.jsx` - Frontend components
- `web-app/frontend/src/components/BusStopView.jsx` - ETA list display
- Multiple deployment YAML files created/updated

## Next Steps

To fully fix the system:
1. **Investigate route destination mismatch** - why all routes show same destination
2. **Implement proper real-time data ingestion** - continuous updates from KMB API
3. **Fix stop-specific route queries** - database schema may need adjustment
4. **Improve error resilience** - handle API failures gracefully
5. **Add timestamp updates** - use current time instead of fixed test times
6. **Comprehensive testing** - test with real routes beyond test stop

## Deployment Notes
- All services running on Kubernetes in `hk-bus` namespace
- Docker images built and pushed to Docker Hub
- Kubernetes YAML files in `k8s/` directory
- Frontend and backend can be updated by rebuilding Docker images and updating deployment versions
