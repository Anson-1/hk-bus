# HK Bus Realtime ETA Tracking System - Quick Start

**One command to set up the entire system:**

```bash
./setup.sh
```

**With end-to-end test:**

```bash
./setup.sh --test
```

## What the Script Does

The `setup.sh` script automates the complete system setup:

1. ✅ **Checks Prerequisites** - Verifies kubectl, docker, and Kubernetes cluster
2. ✅ **Creates Namespace** - Sets up the `hk-bus` Kubernetes namespace
3. ✅ **Deploys All Services** - Deploys Kafka, PostgreSQL, Spark, and Grafana
4. ✅ **Waits for Pods** - Ensures all containers are healthy and ready
5. ✅ **Initializes Database** - Creates tables and schema
6. ✅ **Verifies Kafka** - Checks message queue is working
7. ✅ **Restarts Spark** - Ensures Spark Streaming is ready to process
8. ✅ **Displays Status** - Shows final system status

## Quick Commands

### View System Status
```bash
# Check all pods
kubectl get pods -n hk-bus

# View Spark logs in real-time
kubectl logs -f -l app=spark-streaming -n hk-bus

# View Spark logs (last 20 lines)
kubectl logs -l app=spark-streaming -n hk-bus --tail=20
```

### Access Database
```bash
# Connect to PostgreSQL shell
kubectl exec -it postgres-0 -n hk-bus -- psql -U postgres -d hk_bus

# Query aggregated data
kubectl exec postgres-0 -n hk-bus -- psql -U postgres -d hk_bus \
  -c "SELECT * FROM eta_realtime ORDER BY window_start DESC LIMIT 10;"
```

### Visualize with Grafana
```bash
# Port-forward to Grafana
kubectl port-forward svc/grafana 3000:3000 -n hk-bus

# Open browser: http://localhost:3000
# Default credentials: admin / admin
# Dashboards: Data, Analytics, Infrastructure
```

### Kafka Topic Management
```bash
# List messages in topic
KAFKA_POD=$(kubectl get pods -l app=kafka -n hk-bus -o jsonpath='{.items[0].metadata.name}')
kubectl exec $KAFKA_POD -n hk-bus -- \
  /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 \
  --topic kmb-eta-raw \
  --from-beginning \
  --max-messages 10
```

## System Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Message Input (Kafka)                                  │
│  - Real-time bus ETA messages                           │
│  - JSON format with route, direction, wait time        │
└────────────────┬────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────┐
│  Stream Processing (Spark)                              │
│  - 1-minute tumbling windows                            │
│  - Aggregates by route + direction                      │
│  - Calculates average wait time & delay flag            │
└────────────────┬────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────┐
│  Data Storage (PostgreSQL)                              │
│  - eta_realtime table (current aggregations)            │
│  - eta_raw table (raw messages)                         │
│  - Ready for querying and reporting                     │
└────────────────┬────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────┐
│  Visualization (Grafana)                                │
│  - Real-time dashboards                                │
│  - Route performance metrics                            │
│  - Historical analytics                                 │
└─────────────────────────────────────────────────────────┘
```

## Troubleshooting

### Pods Not Starting
```bash
# Check pod status and events
kubectl describe pod <pod-name> -n hk-bus

# View pod logs
kubectl logs <pod-name> -n hk-bus

# Restart a pod
kubectl delete pod <pod-name> -n hk-bus
```

### No Data in Database
```bash
# Check Spark logs for errors
kubectl logs -l app=spark-streaming -n hk-bus | grep -E "ERROR|Wrote"

# Verify Kafka has messages
KAFKA_POD=$(kubectl get pods -l app=kafka -n hk-bus -o jsonpath='{.items[0].metadata.name}')
kubectl exec $KAFKA_POD -n hk-bus -- \
  /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --describe --topic kmb-eta-raw
```

### Database Connection Issues
```bash
# Test PostgreSQL connection
kubectl exec postgres-0 -n hk-bus -- \
  psql -U postgres -c "SELECT version();"

# Check database exists
kubectl exec postgres-0 -n hk-bus -- \
  psql -U postgres -l | grep hk_bus
```

## Performance Notes

- **Processing Latency**: ~2 minutes (1-minute window + 30-second trigger + write time)
- **Data Retention**: Configured via PostgreSQL retention policies (not set by default)
- **Scalability**: Can handle 100+ messages per second with current configuration
- **Storage**: ~10MB per day for typical bus data

## Next Steps

1. **Automated Data Fetching**: Deploy OpenFaaS to fetch from KMB API every 30 seconds
2. **Analytics**: Run batch jobs for P95 statistics, trends, predictions
3. **Alerting**: Set up Grafana alerts for delayed routes
4. **Data Export**: Configure data pipelines to downstream systems

## Support

For issues or questions:
1. Check PIPELINE_STATUS.md for detailed component information
2. Review SETUP_GUIDE.md for manual installation steps
3. Check TEST_RESULTS.md for test data and examples

---

**Happy Tracking!** 🚌📍
