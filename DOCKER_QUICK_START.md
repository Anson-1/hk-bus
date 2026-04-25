# Docker Quick Start - For Teammates

**Just 3 steps to run everything:**

## Step 1: Install Docker

**Mac/Windows:**
- Download and install [Docker Desktop](https://www.docker.com/products/docker-desktop)
- Open Docker Desktop app
- ⚠️ **Windows**: Make sure WSL2 is enabled (Docker prompts during install)

**Linux:**
```bash
sudo apt-get install docker.io docker-compose-plugin
sudo usermod -aG docker $USER  # Add user to docker group
```

## Step 2: Clone and Start

```bash
# Clone the repo
git clone https://github.com/Anson-1/hk-bus.git
cd hk-bus

# Start everything (this is all you need!)
docker compose up -d
```

## Step 3: Open in Browser

**Web App (Route 91M Tracking):**
```
http://localhost:3000
```

**Grafana Dashboard (Analytics):**
```
http://localhost:3001
Login: admin / admin
```

That's it! 🎉

---

## What Just Started

✅ **PostgreSQL Database** - All bus data  
✅ **Backend API** - Bus tracking service  
✅ **Web App** - Live tracking interface  
✅ **Grafana** - Real-time analytics dashboard  
✅ **Kafka** - Real-time data pipeline  
✅ **ETA Fetcher** - Collecting live data from KMB API  

## Quick Commands

```bash
# View logs (for debugging)
docker compose logs -f

# Stop everything
docker compose down

# Restart a service
docker compose restart web-app

# Clean everything and start fresh
docker compose down -v && docker compose up -d
```

## Troubleshooting

**Windows: "Command not found"?**
- Use **PowerShell** instead of old Command Prompt
- Right-click → "Open PowerShell here"
- Then run: `docker compose up -d`

**"Port 3000 already in use?"**
```bash
# Use different ports
docker compose up -d -p 8000:3000 -p 8001:3001
# Then open: http://localhost:8000
```

**"Grafana dashboards not showing?"**
- Wait 30 seconds for Grafana to initialize
- Refresh: http://localhost:3001
- Click "Dashboards" → "Browse"

**Still stuck?**
1. Check logs: `docker compose logs -f web-app`
2. Ensure Docker has 4GB+ memory
3. Try clean restart: `docker compose down -v && docker compose up -d`

---

For full documentation, see: [DOCKER_COMPOSE_SETUP.md](DOCKER_COMPOSE_SETUP.md)
