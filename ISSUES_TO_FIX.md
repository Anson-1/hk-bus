# Issues to Fix - Next Steps

## Current State (as of 2026-04-23 10:31 UTC+8)

✅ **Working:**
- Web app frontend functional (search, map display, ETA list)
- Backend API returning data and route codes (91P, 91M, 1, 2, 260, 3C, 6)
- Database populated with real route data
- All Kubernetes services operational
- End-to-end data pipeline working

❌ **Problems Identified:**

### 1. **Route Destination Data is Wrong**
- **Issue**: All 7 routes show destination as "CHUK YUEN ESTATE → STAR FERRY"
- **Expected**: Each route should have unique destination (e.g., Route 91P might go to different place than Route 1)
- **Root Cause**: Test data was generated with hardcoded destination for all routes
- **Where**: In `/tmp/insert_final.py` line with `dest = route_info.get('dest_en', f'Route {route_num}')`
- **Fix Needed**: 
  - Verify KMB API actually returns different destinations for different routes
  - Check if the API response structure is correct
  - May need to test with more routes beyond the 7 in current dataset

### 2. **Frontend Shows All Routes for a Single Stop**
- **Issue**: When you click on a stop, it shows all 7 routes (91P, 91M, 1, 2, 260, 3C, 6)
- **Expected**: Should only show routes that actually serve that specific stop
- **Root Cause**: Backend queries "all routes with any data" instead of "routes serving this specific stop"
- **Query**: In backend, we query `SELECT * FROM eta_realtime` without filtering by stop
- **Database Schema Issue**: eta_realtime stores aggregated data per route/window, not per stop/route combination
- **Fix Needed**:
  - Either: Change database schema to track which stops each route serves
  - Or: Query the stop-route relationship from KMB API at request time
  - Or: Properly join eta_realtime with stop_id data

### 3. **Data Timestamps are Static**
- **Issue**: All route data has fixed timestamp from when it was generated
- **Expected**: ETAs should update in real-time
- **Root Cause**: Test data was inserted with `now = datetime.utcnow()` at insertion time
- **Fix Needed**:
  - Implement continuous real-time data ingestion
  - Options:
    a) Kafka producer that continuously fetches from KMB API
    b) Scheduled batch job (every 5-10 seconds)
    c) Spark job directly fetches from KMB API instead of consuming from Kafka

### 4. **KMB API Intermittently Fails**
- **Issue**: Logs show `KafkaTimeoutError`, `403 Forbidden`, `422 Invalid parameter` responses
- **Impact**: Route name fetching fails; backend shows generic error messages
- **Root Cause**: 
  - KMB API rate limiting or blocking
  - Possibly incorrect endpoint parameters
  - Network/connectivity issues
- **Fix Needed**:
  - Implement retry logic with exponential backoff
  - Better error logging to understand which endpoints fail
  - Test endpoints manually to verify they work
  - Consider caching more aggressively

## Recommended Fix Order

### Phase 1: Verify KMB API (Quick Check)
```bash
# Test KMB API endpoints manually
curl https://data.etabus.gov.hk/v1/transport/kmb/route?routes=91P
curl https://data.etabus.gov.hk/v1/transport/kmb/route?routes=1
curl https://data.etabus.gov.hk/v1/transport/kmb/eta/{stopId}/91P
```
**Goal**: Verify API works and returns different destinations for different routes

### Phase 2: Fix Database Schema (If Needed)
- Add `stop_id` column to eta_realtime if not present
- Or create proper junction table: routes ↔ stops
- This allows querying "which stops serve route X" and vice versa

### Phase 3: Fix Backend Query
- Update `/api/eta/:stopId` to only return routes that serve that specific stop
- Probably requires JOIN with route-stop mapping

### Phase 4: Implement Real-Time Data
- Create Kafka producer that fetches from KMB API every 10 seconds
- Or modify Spark job to fetch directly from KMB API
- Push updates continuously to keep data fresh

### Phase 5: Improve Resilience  
- Add retry logic for KMB API calls
- Better error handling and fallbacks
- Comprehensive error logging

## Quick Test Commands

```bash
# 1. Check if route destinations differ in KMB API
curl https://data.etabus.gov.hk/v1/transport/kmb/route?routes=91P | jq '.data[0].dest_en'
curl https://data.etabus.gov.hk/v1/transport/kmb/route?routes=1 | jq '.data[0].dest_en'

# 2. Check which stops serve a route
curl https://data.etabus.gov.hk/v1/transport/kmb/route-stop?route=91P&bound=O | jq '.data[0:3]'
curl https://data.etabus.gov.hk/v1/transport/kmb/route-stop?route=1&bound=O | jq '.data[0:3]'

# 3. Check database schema
kubectl exec -n hk-bus postgres-0 -- psql -U postgres -d hk_bus -c "\d eta_realtime"

# 4. Check what stops are in the test data
kubectl exec -n hk-bus postgres-0 -- psql -U postgres -d hk_bus \
  -c "SELECT DISTINCT stop_id, route FROM eta_raw LIMIT 10;"
```

## Files That Need Changes

1. **Database Migration** (if needed)
   - `k8s/postgres/schema.sql` - Add/modify schema for stop-route relationship

2. **Backend API** 
   - `web-app/backend/server.js` - Fix `/api/eta/:stopId` query logic

3. **Data Ingestion**
   - `scripts/publish_real_routes.py` - Make continuous instead of one-time
   - Or modify `k8s/spark/spark-image/streaming_job.py` to fetch from API

4. **Frontend** (possibly)
   - May need updates if backend response structure changes
   - `web-app/frontend/src/App.jsx`
   - `web-app/frontend/src/components/BusStopView.jsx`

## Success Criteria

After fixing:
- ✅ Different routes show different destinations
- ✅ Stops only show routes that serve them  
- ✅ ETA timestamps update in real-time
- ✅ KMB API calls work without errors
- ✅ Web app displays correct route information
