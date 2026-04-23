# System Architecture

Technical design and implementation details.

---

## Overview

```
KMB ETABus API (Public)
        ↓
  eta-fetcher (Node.js)
  • 15s polling interval
  • 28 stops per direction
  • service_type = 1
        ↓
  PostgreSQL (eta_raw)
  • 2,400 records/cycle
  • Window: last 2 minutes
        ↓
  Backend API (Express.js)
  • REST endpoint: /api/route/:routeNum
  • Aggregation logic
  • Stop detail fetching
        ↓
  Frontend (React + Leaflet)
  • Interactive UI
  • Real-time updates
```

---

## Data Collection (eta-fetcher)

### Service
- **Location**: `k8s/eta-fetcher/server.js`
- **Container**: `ansonhui123/hk-bus-eta-fetcher:v13`
- **Deployment**: Single replica in `hk-bus` namespace
- **Health Check**: Port 3002

### Algorithm
```javascript
Every 15 seconds:
  1. For each route [91M]:
     2. For each direction [inbound, outbound]:
        3. Fetch stops: /route-stop/{route}/{direction}/1
        4. For each stop (up to 30):
           5. Fetch ETA: /eta/{stop_id}/{route}/1
           6. Calculate wait_sec from ETA timestamp
           7. Insert into eta_raw table
```

### Key Parameters
| Parameter | Value | Reason |
|-----------|-------|--------|
| Poll Interval | 15 seconds | Real-time feel, not overwhelming API |
| Stops Limit | 30 | Full route coverage |
| Service Type | 1 | Complete route, not partial service |
| Direction | inbound/outbound | Lowercase, required by KMB API |
| Timeout | 5 seconds | Prevent hanging requests |
| Batch Delay | 50ms between stops | Rate limiting |

### Data Structure
```javascript
{
  route: "91M",        // Route number
  dir: "I",            // Direction: I=inbound, O=outbound
  stop_id: "ABC123",   // Stop identifier from KMB
  wait_sec: 660,       // Seconds until bus arrives
  sample_count: 24,    // Number of ETAs sampled
  fetched_at: "2026-04-23T13:28:00.000Z"  // Collection timestamp
}
```

---

## Database (PostgreSQL)

### Schema
```sql
CREATE TABLE eta_raw (
  id SERIAL PRIMARY KEY,
  route VARCHAR(10),
  dir CHAR(1),              -- 'I' or 'O'
  stop_id VARCHAR(50),
  wait_sec INTEGER,
  delay_flag BOOLEAN,
  fetched_at TIMESTAMP,
  
  INDEX (route, dir, fetched_at)
);
```

### Query Pattern (2-minute window)
```sql
SELECT 
  stop_id,
  AVG(wait_sec) as avg_wait,
  COUNT(*) as sample_count,
  MAX(fetched_at) as latest
FROM eta_raw
WHERE route = '91M'
  AND dir = 'I'
  AND fetched_at > NOW() - INTERVAL '2 minutes'
GROUP BY stop_id
ORDER BY avg_wait ASC;
```

### Data Characteristics
- **Records per cycle**: ~2,400 (28 stops × 85 ETAs average)
- **Inserts per second**: ~160
- **Growth**: 2,400 records every 15 seconds
- **Retention**: 24-48 hours (auto-cleanup possible)

---

## Backend API

### Service
- **Location**: `web-app/backend/server.js`
- **Container**: `ansonhui123/hk-bus-api:v22`
- **Port**: 3001
- **Framework**: Express.js

### Endpoints

#### GET /api/route/:routeNum
```bash
curl http://localhost:3001/api/route/91M
```

**Response**:
```json
{
  "route": {
    "route": "91M",
    "name": "PO LAM - DIAMOND HILL STATION",
    "name_tc": "寶林 - 鑽石山站"
  },
  "stops": [
    {
      "stop_id": "D49A27F89957E305",
      "sequence": 1,
      "name": "TAI PO TSAI VILLAGE (SK107)",
      "name_en": "TAI PO TSAI VILLAGE (SK107)",
      "name_tc": "大埔仔村 (SK107)",
      "lat": 22.336633,
      "lng": 114.259421,
      "wait_sec": 648,
      "sample_count": 24,
      "is_delayed": false,
      "window_start": "2026-04-23T13:28:06.313Z"
    },
    ...
  ],
  "totalStops": 28,
  "stopsWithData": 28
}
```

#### GET /api/health
```bash
curl http://localhost:3001/api/health
```

**Response**:
```json
{
  "status": "ok",
  "timestamp": "2026-04-23T13:28:00.182Z"
}
```

### Aggregation Logic

1. **Direction Priority**
   - Try inbound first: `GET /route-stop/91M/inbound/1`
   - Fallback to outbound: `GET /route-stop/91M/outbound/1`

2. **ETA Aggregation** (last 2 minutes)
   ```sql
   SELECT DISTINCT
     stop_id,
     ROUND(AVG(wait_sec)) AS wait_sec,
     COUNT(*) AS sample_count
   FROM eta_raw
   WHERE route = $1 AND dir = $2
     AND fetched_at > NOW() - INTERVAL '2 minutes'
   GROUP BY stop_id
   ORDER BY wait_sec ASC
   ```

3. **Stop Details** (concurrent batches of 5)
   - Fetch from KMB: `GET /stop/{stop_id}`
   - Extract: name_en, name_tc, lat, long
   - Cache results

4. **Sorting**
   - Primary: wait_sec (ascending - shortest wait first)
   - Display: sequence number (1-28)

---

## Frontend

### Tech Stack
- **Framework**: React 18 with Vite
- **Mapping**: Leaflet + OpenStreetMap
- **HTTP**: Axios
- **Styling**: CSS Grid

### Components

#### SearchBar.jsx
```jsx
- Textbox: Route number input
- Button: Search trigger
- Auto-enable when route typed
- Hardcoded to 91M only (line 13)
```

#### RouteDetailsView.jsx
```jsx
- Left panel: Stop list (1fr width)
- Right panel: Interactive map (1.2fr width)
- Grid layout: responsive
- Sorted by arrival time
- Map markers for each stop
```

### State Management
```javascript
const [route, setRoute] = useState(null);
const [stops, setStops] = useState([]);
const [loading, setLoading] = useState(false);
const [error, setError] = useState(null);

// Fetch on component mount
useEffect(() => {
  fetchRoute('91M');
}, []);
```

### API Integration
```javascript
const API_BASE = '/api';

axios.get(`${API_BASE}/route/91M`)
  .then(res => setStops(res.data.stops))
  .catch(err => setError('Failed to fetch'))
```

---

## KMB API Endpoints Used

### Route Stops
```
GET https://data.etabus.gov.hk/v1/transport/kmb/route-stop/{route}/{direction}/{service_type}

Parameters:
  route: "91M"
  direction: "inbound" or "outbound" (lowercase!)
  service_type: "1" (complete route)

Response: { data: [{ route, bound, seq, stop, service_type }, ...] }
```

### ETA Data
```
GET https://data.etabus.gov.hk/v1/transport/kmb/eta/{stop_id}/{route}/{service_type}

Response: { data: [{ eta, rmk_en, rmk_tc }, ...] }
```

### Stop Details
```
GET https://data.etabus.gov.hk/v1/transport/kmb/stop/{stop_id}

Response: { data: { stop, name_en, name_tc, lat, long } }
```

---

## Deployment Pipeline

### Build
```bash
# eta-fetcher
docker build -t ansonhui123/hk-bus-eta-fetcher:v13 k8s/eta-fetcher/
docker push ansonhui123/hk-bus-eta-fetcher:v13

# Backend API
docker build -t ansonhui123/hk-bus-api:v22 web-app/backend/
docker push ansonhui123/hk-bus-api:v22

# Frontend
docker build -t ansonhui123/hk-bus-web:v11 web-app/frontend/
docker push ansonhui123/hk-bus-web:v11
```

### Deploy
```bash
kubectl set image deployment/eta-fetcher -n hk-bus \
  eta-fetcher=ansonhui123/hk-bus-eta-fetcher:v13

kubectl set image deployment/hk-bus-api -n hk-bus \
  hk-bus-api=ansonhui123/hk-bus-api:v22

kubectl set image deployment/hk-bus-web -n hk-bus \
  web=ansonhui123/hk-bus-web:v11
```

---

## Performance Metrics

### Data Collection
- Stops fetched: 28 inbound + 29 outbound
- ETAs per stop: 85 avg (varies by demand)
- Records per cycle: ~2,400
- Cycle time: 15 seconds
- Throughput: 160 records/sec
- Database inserts/sec: 160

### API Response Times
- Route lookup: <100ms (cache hits)
- Stop details: ~500ms (batched, 5 parallel)
- Total endpoint: <600ms

### Frontend
- Initial load: 2-3 seconds
- Map render: 28 markers in <500ms
- List render: 28 stops in <200ms

---

## Error Handling

### eta-fetcher
- Silently skip: KMB API errors (some stops may not have service)
- Warn: Database insert failures
- Continue: Partial data collection
- Retry: Built-in exponential backoff via Axios

### Backend API
- Try inbound/1, then inbound/2, then outbound/1
- Return empty array if all fail
- Log error to console
- 5-second timeout on all HTTP requests

### Frontend
- Display error message: "Failed to fetch route details"
- Show loading spinner during fetch
- Graceful degradation: Show empty list if no stops

---

## Monitoring

### Health Checks
```bash
# eta-fetcher
curl http://localhost:3002/health

# Backend API  
curl http://localhost:3001/api/health

# Frontend
curl http://localhost:3000/
```

### Logs
```bash
# eta-fetcher
kubectl logs -n hk-bus -l app=eta-fetcher --tail=50

# Backend
kubectl logs -n hk-bus -l app=hk-bus-api --tail=50

# Frontend
kubectl logs -n hk-bus -l app=hk-bus-web --tail=50
```

### Database Queries
```bash
# Record count
SELECT COUNT(*) FROM eta_raw WHERE route='91M';

# Stops with data
SELECT DISTINCT stop_id FROM eta_raw WHERE route='91M';

# Latest records
SELECT * FROM eta_raw ORDER BY fetched_at DESC LIMIT 10;
```

---

## Known Limitations

1. **Only Route 91M tracked** - Can add more routes to MONITORED_ROUTES
2. **2-minute data window** - Could extend to hourly for analytics
3. **No historical archive** - Data older than 24 hours is discarded
4. **Single direction at a time** - API returns only the inbound route
5. **Stop order based on ETA** - Not route sequence order
