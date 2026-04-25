# Dashboard Setup Explanation

## Overview
Your **Route 91M - Real-time Analytics** dashboard is now properly provisioned as an Infrastructure-as-Code configuration. Here's how it works:

## Architecture

### 1. **Dashboard JSON File** (`grafana/dashboards/route-91m-realtime-analytics.json`)
- Contains the complete dashboard definition (panels, queries, layout)
- 7 panels total:
  - **Total Records (1h)**: Stat panel counting records from `eta_processed` table
  - **Time Windows (1h)**: Stat panel counting distinct `window_start` timestamps
  - **Avg Wait Time (1h)**: Stat panel with average wait seconds (green/yellow/red thresholds)
  - **Delay Incidents (1h)**: Stat panel counting rows where `delay_flag = true`
  - **Wait Time Trends - Route 91M**: Time series chart showing trends over 24 hours
  - **Data by Direction**: Pie chart showing records distribution by direction
  - **Detailed Metrics - Route 91M**: Table showing last 50 records with stop-level details

### 2. **Kubernetes ConfigMap** (`k8s/grafana/grafana.yaml`)
Contains 3 ConfigMaps:

#### a) `grafana-datasources`
- Defines PostgreSQL datasource pointing to `postgres-db.hk-bus.svc.cluster.local:5432`
- Defines Prometheus datasource for Kubernetes metrics

#### b) `grafana-dashboard-provider`
- Tells Grafana where to find dashboards: `/var/lib/grafana/dashboards`
- Auto-provisions any JSON files in that path

#### c) `grafana-dashboards` (NEW)
- Contains all dashboard JSON files (base64-encoded):
  - analytics-dashboard.json
  - data-dashboard.json
  - infra-dashboard.json
  - **route-91m-realtime-analytics.json** ← Your dashboard

### 3. **Grafana Deployment**
Mounts the ConfigMaps:
```yaml
volumeMounts:
  - name: dashboards
    mountPath: /var/lib/grafana/dashboards
volumes:
  - name: dashboards
    configMap:
      name: grafana-dashboards
```

## How It Works (Flow)

```
1. Kubectl applies grafana.yaml
   ↓
2. Kubernetes creates ConfigMaps in etcd
   ↓
3. Grafana pod starts and mounts ConfigMaps as volumes
   ↓
4. ConfigMap contents appear as JSON files in /var/lib/grafana/dashboards/
   ↓
5. Grafana provisioning service reads dashboards.yaml
   ↓
6. Grafana automatically provisions all JSON files in that directory
   ↓
7. Dashboard appears in Grafana UI at startup (no manual creation needed)
```

## Dashboard Queries

Each panel queries `eta_processed` table:

| Panel | SQL Query | Purpose |
|-------|-----------|---------|
| Total Records | `COUNT(*) FROM eta_processed WHERE route='91M' AND window_start > NOW()-1h` | Show data volume |
| Time Windows | `COUNT(DISTINCT window_start)` | Show how many 1-min windows collected |
| Avg Wait Time | `AVG(avg_wait_sec)` | Show average wait for Route 91M |
| Delay Incidents | `COUNT(*) WHERE delay_flag=true` | Show delay frequency |
| Wait Time Trends | `window_start, direction, avg_wait_sec` over 24h | Visualize trends by direction |
| Data by Direction | `GROUP BY direction` | Show which direction has more data |
| Detailed Metrics | Last 50 records with stop-level breakdown | Detailed diagnostics |

## How Your Dashboard Was Created

1. **Manually created in Grafana UI** during development
2. **Exported via API**: `curl -u admin:admin http://localhost:3000/api/dashboards/uid/route-91m`
3. **Saved to repo**: `grafana/dashboards/route-91m-realtime-analytics.json`
4. **Added to ConfigMap**: Included in `k8s/grafana/grafana.yaml`
5. **Now provisioned automatically**: When teammates deploy, dashboard appears instantly

## Next Steps for Teammates

When teammates deploy:
```bash
kubectl apply -f k8s/
```

The dashboard will be available immediately at:
- **Local**: `http://localhost:3000` (after port-forward)
- **In cluster**: `http://grafana.hk-bus.svc.cluster.local:3000`

**Login**: admin / admin

## Editing the Dashboard

### Option 1: Edit in Grafana UI (temporary)
- Changes persist only in Grafana's database
- Lost on pod restart unless exported

### Option 2: Edit JSON file (permanent)
1. Modify `grafana/dashboards/route-91m-realtime-analytics.json`
2. Update ConfigMap: `kubectl apply -f k8s/grafana/grafana.yaml`
3. Restart Grafana pod: `kubectl rollout restart deployment/grafana -n hk-bus`

### Option 3: Export from UI (recommended)
1. In Grafana, click dashboard name → **Share** → **Export**
2. Copy JSON
3. Replace `grafana/dashboards/route-91m-realtime-analytics.json`
4. Commit to git

## Benefits of This Setup

✅ **Version controlled**: Dashboard definition in git  
✅ **Reproducible**: Teammates get identical dashboard on first deploy  
✅ **No manual steps**: Provisioning happens automatically  
✅ **Easy updates**: Change JSON → apply ConfigMap → dashboard updates  
✅ **Scalable**: Can add more dashboards by adding more JSON files  

