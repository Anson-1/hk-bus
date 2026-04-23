# 🚀 HK Bus Tracking System - SETUP & RUN

## Fastest Way to Get Started

```bash
cd /Users/shiyangxu/Desktop/hk-bus
./setup.sh --test
```

That's it! The script will:
- Deploy Kafka, PostgreSQL, Spark, and Grafana
- Initialize the database
- Run an end-to-end test
- Show you the results

**Time: ~5-10 minutes**

---

## What Each Command Does

```bash
# View help and options
./setup.sh --help

# Setup without test (just deploy services)
./setup.sh

# Setup WITH automatic test (recommended)
./setup.sh --test
```

---

## After Setup

### View Real-Time Logs
```bash
kubectl logs -f -l app=spark-streaming -n hk-bus
```

### View Grafana Dashboards
```bash
kubectl port-forward svc/grafana 3000:3000 -n hk-bus
# Then open: http://localhost:3000
# Default: admin / admin
```

### Query the Database
```bash
kubectl exec -it postgres-0 -n hk-bus -- psql -U postgres -d hk_bus

# In psql:
SELECT * FROM eta_realtime ORDER BY window_start DESC LIMIT 10;
```

### Check System Status
```bash
kubectl get pods -n hk-bus
```

---

## Documentation

- **QUICKSTART.md** - Quick reference for common commands
- **PIPELINE_STATUS.md** - System status and fixes applied
- **SETUP_GUIDE.md** - Complete manual setup guide
- **TEST_RESULTS.md** - Test results and validation

---

## System Architecture

```
Real-time Bus ETA Data
      ↓
Kafka Message Queue (kmb-eta-raw topic)
      ↓
Spark Streaming (1-minute aggregation windows)
      ↓
PostgreSQL Database (eta_realtime table)
      ↓
Grafana Dashboards (visualization)
```

---

## Troubleshooting

**Problem: Pods not starting?**
```bash
kubectl describe pod <pod-name> -n hk-bus
kubectl logs <pod-name> -n hk-bus
```

**Problem: No data in database?**
```bash
# Check Spark logs for errors
kubectl logs -l app=spark-streaming -n hk-bus | grep ERROR

# Check if Kafka has messages
KAFKA_POD=$(kubectl get pods -l app=kafka -n hk-bus -o jsonpath='{.items[0].metadata.name}')
kubectl exec $KAFKA_POD -n hk-bus -- /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --describe --topic kmb-eta-raw
```

**Problem: Can't connect to PostgreSQL?**
```bash
kubectl exec postgres-0 -n hk-bus -- psql -U postgres -c "SELECT version();"
```

---

## Next Steps

1. ✅ Run the setup: `./setup.sh --test`
2. ✅ Monitor the pipeline: `kubectl logs -f -l app=spark-streaming -n hk-bus`
3. ✅ View dashboards: `kubectl port-forward svc/grafana 3000:3000 -n hk-bus`
4. ✅ Query data: `kubectl exec -it postgres-0 -n hk-bus -- psql -U postgres -d hk_bus`

---

## Need Help?

Check:
1. **RUN_ME.md** (this file) - Quick start
2. **QUICKSTART.md** - Common commands
3. **PIPELINE_STATUS.md** - System details
4. **SETUP_GUIDE.md** - Detailed setup instructions

---

**Ready? Let's go!**
```bash
./setup.sh --test
```
