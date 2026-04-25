# Docker Compose Setup Guide

The easiest way to run the entire HK Bus system on your local machine with Docker Compose.

## Prerequisites

- **Docker** (v20.10+)
- **Docker Compose** (v2.0+)

**Install Docker:**
- [Docker Desktop for Mac](https://www.docker.com/products/docker-desktop)
- [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop)
- [Docker for Linux](https://docs.docker.com/engine/install/)

Check versions:
```bash
docker --version
docker-compose --version
```

## Quick Start (2 Commands)

```bash
# Clone the repository
git clone https://github.com/Anson-1/hk-bus.git
cd hk-bus

# Start everything
docker-compose up -d

# Wait 30 seconds for services to initialize, then open:
open http://localhost:3000
```

That's it! 🎉

## What Gets Started

| Service | Port | URL | Login |
|---------|------|-----|-------|
| **Web App** (Frontend + API) | 3000 | http://localhost:3000 | N/A |
| **Grafana Dashboard** | 3001 | http://localhost:3001 | admin / admin |
| **PostgreSQL Database** | 5432 | localhost:5432 | postgres / postgres |
| **Backend API** | 5000 | http://localhost:5000 | N/A |
| **Kafka** | 9092 | localhost:9092 | N/A |
| **Zookeeper** | 2181 | localhost:2181 | N/A |

## Usage

### Start All Services
```bash
docker-compose up -d
```

### View Logs
```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f web-app
docker-compose logs -f grafana
docker-compose logs -f postgres-db
```

### Stop All Services
```bash
docker-compose down
```

### Stop and Remove Volumes (Clean Slate)
```bash
docker-compose down -v
```

### Restart a Single Service
```bash
docker-compose restart web-app
```

## Accessing the System

### Web App (Route 91M Tracking)
- **URL:** http://localhost:3000
- **Features:**
  - Real-time Route 91M bus tracking
  - Live ETA for all stops
  - Route visualization on map
  - Historical data

### Grafana Dashboards
- **URL:** http://localhost:3001
- **Login:** `admin` / `admin`
- **Available Dashboards:**
  - **Route 91M - Real-time Analytics**: Main dashboard with wait times, trends, and detailed metrics
  - **KMB Bus Data Dashboard**: General bus data analytics
  - **KMB Analytics Dashboard**: Historical trends and route rankings
  - **Infrastructure Dashboard**: System performance metrics

### Backend API
- **URL:** http://localhost:5000
- **Endpoints:**
  - `GET /api/routes` - List all routes
  - `GET /api/route/{routeId}/stops` - Get stops for route
  - `WS /api/route-live` - WebSocket for real-time updates

### PostgreSQL Database
```bash
# Connect via psql
psql -h localhost -U postgres -d hk_bus

# Or from Docker
docker-compose exec postgres-db psql -U postgres -d hk_bus
```

## Troubleshooting

### Port Already in Use
If port 3000 or 3001 is already in use:

```bash
# Change ports in docker-compose.yml:
# Change "3000:3000" to "8080:3000" for web-app
# Change "3001:3000" to "8001:3000" for grafana
```

### Services Not Responding
```bash
# Check service status
docker-compose ps

# View logs for the failing service
docker-compose logs postgres-db
docker-compose logs web-app
docker-compose logs grafana
```

### Grafana Dashboards Not Appearing
1. Wait 30 seconds for Grafana to initialize
2. Refresh browser at http://localhost:3001
3. Click "Dashboards" → "Browse" → "HK Bus" folder

### Out of Memory
Docker Compose might need more resources. Increase Docker's memory limit:
- **Mac/Windows:** Docker Desktop → Preferences → Resources → Increase Memory to 4GB+
- **Linux:** Configure Docker daemon

### Clean Restart
```bash
# Stop everything and remove all data
docker-compose down -v

# Start fresh
docker-compose up -d
```

## Files Structure

```
hk-bus/
├── docker-compose.yml                 ← Main configuration (THIS FILE!)
├── web-app/
│   ├── Dockerfile
│   ├── backend/
│   └── frontend/
├── k8s/
│   ├── postgres/
│   │   └── init.sql                   ← Database schema
│   └── grafana/
│       └── provisioning/               ← Grafana auto-config
│           ├── datasources/
│           └── dashboards/
├── grafana/
│   └── dashboards/                    ← Dashboard JSON files
│       ├── route-91m-realtime-analytics.json
│       ├── analytics-dashboard.json
│       └── ...
└── README.md
```

## Database Initialization

The PostgreSQL database is auto-initialized with:
- **Schema** from `k8s/postgres/init.sql`
- **Tables:** `eta_processed`, `eta_analytics`, `routes`, `stops`, etc.
- **Data:** Real-time data collected from KMB API

First startup takes ~10 seconds for the database to initialize.

## Performance Tips

### For Low-End Machines
1. Disable ETA Fetcher if you only need dashboards:
   ```bash
   docker-compose up -d postgres-db kafka web-app grafana
   ```

2. Reduce container resource limits in `docker-compose.yml`:
   ```yaml
   resources:
     limits:
       cpus: '0.5'
       memory: 512M
   ```

### For Development
```bash
# Run with verbose output
docker-compose up

# Don't detach; see all logs in real-time
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Docker Compose Stack                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  Web App     │  │   Backend    │  │  Grafana     │      │
│  │  :3000       │  │   API :5000  │  │  :3001       │      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
│         │                 │                 │               │
│         └─────────────────┼─────────────────┘               │
│                           │                                 │
│    ┌──────────────────────┼──────────────────────┐          │
│    │                      ▼                      │          │
│    │         ┌──────────────────────┐            │          │
│    │         │   PostgreSQL DB      │            │          │
│    │         │   :5432              │            │          │
│    │         └──────────────────────┘            │          │
│    │                                              │          │
│    │         ┌──────────────────────┐            │          │
│    │         │   Kafka + Zookeeper  │            │          │
│    │         │   :9092 / :2181      │            │          │
│    │         └──────────────────────┘            │          │
│    │                                              │          │
│    │         ┌──────────────────────┐            │          │
│    │         │   ETA Fetcher        │            │          │
│    │         │   (Real-time data)   │            │          │
│    │         └──────────────────────┘            │          │
│    └──────────────────────────────────────────────┘          │
│                                                              │
│              All on: hk-bus-network (bridge)                │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Next Steps

1. **For teammates:**
   ```bash
   # That's all they need!
   git clone https://github.com/Anson-1/hk-bus.git
   cd hk-bus
   docker-compose up -d
   open http://localhost:3000
   ```

2. **For development:**
   - Modify code in `web-app/` → changes reflect on restart
   - Rebuild images: `docker-compose build`
   - See logs: `docker-compose logs -f`

3. **For deployment to production:**
   - Use Kubernetes manifests in `k8s/` directory
   - Deploy to cloud (AWS, Google Cloud, Azure)
   - Uses same Docker images

## Support

If you encounter issues:
1. Check logs: `docker-compose logs -f`
2. Ensure Docker/Docker Compose are up-to-date
3. Try clean restart: `docker-compose down -v && docker-compose up -d`
4. Check file permissions: `ls -la k8s/postgres/init.sql`
