# HK Bus Tracking System - Complete Setup Guide

**Setup Time:** ~20-30 minutes  
**Complexity:** Intermediate (requires Docker, Kubernetes, Helm, kubectl)

This guide walks you through setting up the entire HK Bus real-time ETA tracking system from scratch.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Step 1: Prepare Environment](#step-1-prepare-environment)
3. [Step 2: Clone Repository](#step-2-clone-repository)
4. [Step 3: Configure Kubernetes](#step-3-configure-kubernetes)
5. [Step 4: Build Docker Images](#step-4-build-docker-images)
6. [Step 5: Deploy Core Services](#step-5-deploy-core-services)
7. [Step 6: Deploy Data Pipeline](#step-6-deploy-data-pipeline)
8. [Step 7: Configure Grafana](#step-7-configure-grafana)
9. [Step 8: Verify Installation](#step-8-verify-installation)
10. [Step 9: Test the Pipeline](#step-9-test-the-pipeline)
11. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Required Software

- **macOS** (this guide is tested on macOS; Linux/Windows may require adjustments)
- **Docker Desktop** with Kubernetes enabled
- **kubectl** (usually included with Docker Desktop)
- **Helm** (for package management)
- **git** (to clone the repository)
- **Python 3.11+** (optional, for local testing)

### System Requirements

- **CPU:** 4+ cores
- **RAM:** 8GB+ (minimum for all services running simultaneously)
- **Disk:** 10GB+ free space
- **Internet:** Required for pulling Docker images and calling APIs

### Check Prerequisites

```bash
# Check Docker
docker --version
# Expected: Docker version 20.10+

# Check Kubernetes
kubectl version --client
# Expected: Client version 1.24+

# Check if Docker Desktop has Kubernetes enabled
kubectl get nodes
# Expected: One node named "docker-desktop" in Ready state

# Check Helm
helm version
# Expected: version.BuildInfo{Version:"v3.0+"}
```

If any of these fail, install the missing tools:
```bash
# macOS with Homebrew
brew install helm
```

---

## Step 1: Prepare Environment

### 1.1 Verify Kubernetes Context

```bash
# Check current context
kubectl config current-context
# Expected output: docker-desktop

# If not set to docker-desktop, switch context
kubectl config use-context docker-desktop

# Verify Kubernetes is running
kubectl get nodes
# Expected: One Ready node named docker-desktop
```

### 1.2 Create Required Namespaces

```bash
# The main hk-bus namespace (for data pipeline)
kubectl create namespace hk-bus

# Check namespace was created
kubectl get ns hk-bus
```

### 1.3 Optional: Increase Docker Desktop Resources

For better performance, increase Docker Desktop memory to 8GB+:
1. Open Docker Desktop → Preferences → Resources
2. Set Memory to **8GB** or higher
3. Click "Apply & Restart"

---

## Step 2: Clone Repository

```bash
# Clone the repository
git clone https://github.com/Anson-1/hk-bus.git
cd hk-bus

# Verify directory structure
ls -la
# Should show: k8s/, functions/, grafana/, scripts/, tests/, etc.

# Check current branch
git status
```

---

## Step 3: Configure Kubernetes

### 3.1 Create Namespace

```bash
# Apply namespace definition
kubectl apply -f k8s/namespace.yaml

# Verify
kubectl get namespace hk-bus
```

### 3.2 Verify Docker Desktop K8s is Ready

```bash
# Check cluster info
kubectl cluster-info

# Check all system pods are running
kubectl get pods --all-namespaces

# Wait for kube-system pods to be ready
kubectl get pods -n kube-system
# All should be Running or Completed
```

---

## Step 4: Build Docker Images

### 4.1 Build Spark Image

The Spark image contains PySpark, PostgreSQL driver, and Kafka connector.

```bash
# Navigate to Spark image directory
cd k8s/spark/spark-image

# Build the image (uses local Docker daemon)
docker build -t kmb-spark:v3 .

# Verify image was built
docker images | grep kmb-spark
# Expected: kmb-spark              v3          <image-id>    ...

# Return to repo root
cd ../../..
```

**What's in this image:**
- Python 3.11
- PySpark 3.5.0
- PostgreSQL JDBC driver
- Kafka connector (org.apache.spark:spark-sql-kafka-0-10)
- Structured Streaming libraries

### 4.2 Build kmb-fetcher Function (Optional - for automated data fetching)

```bash
# Navigate to function directory
cd functions/kmb-fetcher

# Build the function
docker build -t kmb-fetcher:latest .

# Verify
docker images | grep kmb-fetcher

# Return to repo root
cd ../..
```

**Note:** This image is optional. You can test the pipeline by manually publishing messages to Kafka.

---

## Step 5: Deploy Core Services

### 5.1 Deploy Zookeeper

Zookeeper is required by Kafka for coordination.

```bash
# Deploy Zookeeper
kubectl apply -f k8s/kafka/zookeeper.yaml

# Wait for Zookeeper to be ready
kubectl wait --for=condition=ready pod -l app=zookeeper -n hk-bus --timeout=60s

# Verify
kubectl get pods -n hk-bus -l app=zookeeper
# Expected: zookeeper-0    1/1     Running
```

### 5.2 Deploy Kafka

Kafka is the message broker (equivalent to AWS Kinesis).

```bash
# Deploy Kafka
kubectl apply -f k8s/kafka/kafka.yaml

# Wait for Kafka to be ready
kubectl wait --for=condition=ready pod -l app=kafka -n hk-bus --timeout=120s

# Verify
kubectl get pods -n hk-bus -l app=kafka
# Expected: kafka-0    1/1     Running

# Check Kafka logs (optional - should see "started" and cluster info)
kubectl logs kafka-0 -n hk-bus | grep -E "started|broker|cluster"
```

**Key configuration:**
- Service: `kafka-broker` (for external access) + `kafka-svc` (for pod discovery)
- Advertised host: `kafka-0.kafka-svc.hk-bus.svc.cluster.local:9092`
- Topic: `kmb-eta-raw` (auto-created)
- Partitions: 1, Replication: 1

### 5.3 Deploy PostgreSQL

PostgreSQL stores real-time and historical data.

```bash
# Deploy PostgreSQL
kubectl apply -f k8s/postgres/postgres.yaml

# Wait for PostgreSQL to be ready
kubectl wait --for=condition=ready pod -l app=postgres -n hk-bus --timeout=120s

# Verify
kubectl get pods -n hk-bus -l app=postgres
# Expected: postgres-0    1/1     Running

# Check if schema was initialized
kubectl logs postgres-0 -n hk-bus | grep -i "role\|schema\|create"
```

**What gets initialized:**
- Database: `hk_bus`
- Tables: `eta_raw`, `eta_realtime`, `eta_analytics`
- Schema migrations are in `k8s/postgres/init.sql`
- Default credentials: username=`admin`, password=`admin`

---

## Step 6: Deploy Data Pipeline

### 6.1 Deploy Spark Streaming

Spark Streaming reads from Kafka and aggregates data every minute.

```bash
# Deploy Spark Streaming
kubectl apply -f k8s/spark/streaming-deployment.yaml

# Wait for Spark to be ready
kubectl wait --for=condition=ready pod -l app=spark-streaming -n hk-bus --timeout=120s

# Verify
kubectl get pods -n hk-bus -l app=spark-streaming
# Expected: spark-streaming-xxx    1/1     Running

# Check Spark logs (look for "Spark SQL Streaming" messages)
kubectl logs -l app=spark-streaming -n hk-bus --tail=50
```

**What Spark does:**
- Subscribes to Kafka topic: `kmb-eta-raw`
- Tumbling window: 1 minute
- Aggregations: avg_wait_sec, avg_delay_flag, sample_count
- Output: Writes to PostgreSQL `eta_realtime` table
- Trigger: Processes every 30 seconds

### 6.2 Deploy Spark Batch Job (Optional)

Hourly analytics computation.

```bash
# Deploy batch CronJob
kubectl apply -f k8s/spark/batch-cronjob.yaml

# Verify CronJob is created
kubectl get cronjobs -n hk-bus
# Expected: spark-batch-analytics    0 * * * *    ...

# Check if it has executed (after 1 hour or manually trigger)
kubectl get jobs -n hk-bus
```

**Note:** This CronJob computes P95 statistics hourly. You can test it manually:

```bash
# Create one-off job from the CronJob spec
kubectl create job spark-batch-test --from=cronjob/spark-batch-analytics -n hk-bus

# Watch its progress
kubectl logs -l job-name=spark-batch-test -n hk-bus --follow
```

---

## Step 7: Configure Grafana

### 7.1 Deploy Grafana

Grafana provides real-time dashboards.

```bash
# Deploy Grafana
kubectl apply -f k8s/grafana/grafana.yaml

# Wait for Grafana to be ready
kubectl wait --for=condition=ready pod -l app=grafana -n hk-bus --timeout=120s

# Verify
kubectl get pods -n hk-bus -l app=grafana
# Expected: grafana-xxx    1/1     Running

# Check Grafana logs
kubectl logs -l app=grafana -n hk-bus | grep -i "http server\|listen"
```

### 7.2 Load Grafana Dashboards

Create ConfigMap with dashboard definitions:

```bash
# Create ConfigMap with all three dashboards
kubectl create configmap grafana-dashboards \
  --from-file=grafana/dashboards/data-dashboard.json \
  --from-file=grafana/dashboards/analytics-dashboard.json \
  --from-file=grafana/dashboards/infra-dashboard.json \
  --namespace hk-bus \
  --dry-run=client -o yaml | kubectl apply -f -

# Verify ConfigMap was created
kubectl get configmap -n hk-bus grafana-dashboards

# Restart Grafana to load dashboards
kubectl rollout restart deployment/grafana -n hk-bus

# Wait for restart
kubectl wait --for=condition=ready pod -l app=grafana -n hk-bus --timeout=60s
```

### 7.3 Access Grafana UI

```bash
# Port forward to Grafana
kubectl port-forward -n hk-bus svc/grafana 3000:3000 &

# Open browser
# URL: http://localhost:3000
# Username: admin
# Password: admin

# Navigate to: Dashboards → HK Bus
# You should see three dashboards:
# 1. Data Dashboard - Live route wait times
# 2. Analytics Dashboard - Historical trends (P95, etc.)
# 3. Infrastructure Dashboard - Pod count, metrics
```

**Troubleshooting dashboards:**
- If dashboards are blank, check PostgreSQL datasource:
  - Settings → Data Sources → PostgreSQL
  - Should point to: `postgres-db.hk-bus.svc.cluster.local:5432`
  - Database: `hk_bus`
  - Password: `admin`

---

## Step 8: Verify Installation

### 8.1 Check All Pods Are Running

```bash
# List all pods in hk-bus namespace
kubectl get pods -n hk-bus

# Expected output:
# NAME               READY   STATUS    RESTARTS   AGE
# zookeeper-0        1/1     Running   0          5m
# kafka-0            1/1     Running   0          4m
# postgres-0         1/1     Running   0          3m
# spark-streaming-xxx 1/1     Running   0          2m
# grafana-xxx        1/1     Running   0          1m

# If any pod is not Running, check logs:
kubectl describe pod <pod-name> -n hk-bus
kubectl logs <pod-name> -n hk-bus
```

### 8.2 Check Kafka Topic

```bash
# Port forward to Kafka (or use cluster IP)
kubectl port-forward -n hk-bus svc/kafka-broker 9092:9092 &

# List topics
kafka-topics.sh --bootstrap-server localhost:9092 --list

# Expected output includes: kmb-eta-raw

# Check topic details
kafka-topics.sh --bootstrap-server localhost:9092 --describe --topic kmb-eta-raw
```

### 8.3 Check PostgreSQL Database

```bash
# Connect to PostgreSQL pod
kubectl exec -it postgres-0 -n hk-bus -- psql -U admin -d hk_bus

# Inside psql:
\dt                          # List tables
SELECT * FROM eta_realtime;  # Query realtime data
\q                           # Exit

# Or in one command:
kubectl exec -it postgres-0 -n hk-bus -- psql -U admin -d hk_bus -c "\dt"
```

### 8.4 Check Spark Streaming Status

```bash
# View Spark logs
kubectl logs -l app=spark-streaming -n hk-bus --tail=100

# Look for:
# - "Initializing Spark context"
# - "Subscribing to kafka topic: kmb-eta-raw"
# - "Processed X records" (if data is flowing)

# Watch logs in real-time
kubectl logs -l app=spark-streaming -n hk-bus --follow
```

---

## Step 9: Test the Pipeline

### 9.1 Manual Message Publishing (Easiest Test)

This tests the entire pipeline without needing the kmb-fetcher function.

```bash
# 1. Port forward Kafka
kubectl port-forward -n hk-bus svc/kafka-broker 9092:9092 &

# 2. Open a producer console
kafka-console-producer.sh --broker-list localhost:9092 --topic kmb-eta-raw

# 3. Paste this JSON message (then press Enter):
{"route": "1", "direction": "1", "wait_sec": 300, "delay_flag": false}

# 4. Send 10 test messages (copy-paste this 10 times)
{"route": "1", "direction": "1", "wait_sec": 300, "delay_flag": false}

# 5. Check Kafka consumer (in another terminal)
kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 \
  --topic kmb-eta-raw \
  --from-beginning

# 6. After 1 minute, check PostgreSQL for aggregated results
kubectl exec -it postgres-0 -n hk-bus -- psql -U admin -d hk_bus -c \
  "SELECT route, direction, avg_wait_sec, delay_flag, sample_count FROM eta_realtime ORDER BY window_start DESC LIMIT 1;"

# Expected output (after 1 minute):
# route | direction | avg_wait_sec | delay_flag | sample_count
#   1   |     1     |     300      |    false   |      10
```

**Timeline:**
- **0s:** Messages published to Kafka
- **0-30s:** Spark reads from Kafka, buffers messages
- **30s:** Spark processes first batch (may not aggregate if < 1 min)
- **60s:** Spark processes second batch, aggregates into 1-minute window
- **60-65s:** Results written to PostgreSQL
- **65+s:** Query returns results

### 9.2 Check Data in Grafana

```bash
# If port-forward is still running, open Grafana
# http://localhost:3000

# Go to: Dashboards → HK Bus → Data Dashboard
# Should show Route 1 with wait time of 300 seconds
```

### 9.3 Full End-to-End Test (with metrics)

```bash
# Terminal 1: Watch Kafka messages
kubectl port-forward -n hk-bus svc/kafka-broker 9092:9092 &
kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic kmb-eta-raw --from-beginning &

# Terminal 2: Watch Spark logs
kubectl logs -l app=spark-streaming -n hk-bus --follow

# Terminal 3: Watch PostgreSQL
watch -n 5 "kubectl exec -it postgres-0 -n hk-bus -- psql -U admin -d hk_bus -c \"SELECT COUNT(*) FROM eta_realtime;\""

# Terminal 4: Publish test data
kubectl port-forward -n hk-bus svc/kafka-broker 9092:9092 &
kafka-console-producer.sh --broker-list localhost:9092 --topic kmb-eta-raw
# (paste messages)
```

---

## Troubleshooting

### Issue 1: Pod stuck in Pending

```bash
# Check pod events
kubectl describe pod <pod-name> -n hk-bus

# Common causes:
# - Insufficient resources: Check "kubectl top nodes"
# - Image pull failure: Check image name in YAML
# - Node selector mismatch: Check "kubectl get nodes --show-labels"

# Solutions:
# - Increase Docker Desktop memory to 8GB
# - Verify Docker images exist: docker images
# - Remove node selector from YAML if present
```

### Issue 2: Pod in CrashLoopBackOff

```bash
# Check logs
kubectl logs <pod-name> -n hk-bus

# Common causes:
# - Missing environment variables
# - Configuration errors
# - Failed to connect to dependency (Kafka, PostgreSQL, etc.)

# Solutions:
# - Check YAML for missing env vars
# - Verify dependency pod is Running
# - Check YAML indentation (YAML is whitespace-sensitive)
```

### Issue 3: Kafka messages not being consumed

```bash
# Verify topic exists
kafka-topics.sh --bootstrap-server localhost:9092 --describe --topic kmb-eta-raw

# Verify Spark is subscribed
kubectl logs -l app=spark-streaming -n hk-bus | grep "Subscribing\|Connected"

# Publish test message again
kafka-console-producer.sh --broker-list localhost:9092 --topic kmb-eta-raw
# Paste: {"route": "1", "direction": "1", "wait_sec": 300, "delay_flag": false}

# Watch Spark logs
kubectl logs -l app=spark-streaming -n hk-bus --follow
```

### Issue 4: PostgreSQL datasource not working in Grafana

```bash
# Check PostgreSQL is accessible
kubectl exec -it postgres-0 -n hk-bus -- psql -U admin -d hk_bus -c "SELECT 1;"

# Check Grafana datasource configuration
# Go to: Settings → Data Sources → PostgreSQL
# Verify:
# - Host: postgres-db.hk-bus.svc.cluster.local:5432
# - Database: hk_bus
# - Username: admin
# - Password: admin
# - SSL Mode: disable

# Test connection by clicking "Save & Test"
```

### Issue 5: Ports already in use

```bash
# Kill existing port-forward
pkill -f "kubectl port-forward"

# Or specify a different port
kubectl port-forward -n hk-bus svc/grafana 3001:3000
# Open http://localhost:3001
```

### Issue 6: Out of memory

```bash
# Check current resource usage
kubectl top nodes
kubectl top pods -n hk-bus

# Increase Docker Desktop memory:
# Docker Desktop → Preferences → Resources → Memory: 8GB or higher
# Click "Apply & Restart"
```

### Issue 7: Complete reset/cleanup

```bash
# Delete the entire hk-bus namespace (destroys all data)
kubectl delete namespace hk-bus

# Re-create and re-deploy
kubectl apply -f k8s/namespace.yaml
# ... repeat Steps 5-7 ...
```

---

## Quick Reference Commands

### Monitoring

```bash
# Watch all pods
kubectl get pods -n hk-bus -w

# Check resource usage
kubectl top pods -n hk-bus

# Tail logs from any service
kubectl logs -l app=kafka -n hk-bus --tail=50 --follow
kubectl logs -l app=spark-streaming -n hk-bus --tail=50 --follow
kubectl logs -l app=postgres -n hk-bus --tail=50 --follow
kubectl logs -l app=grafana -n hk-bus --tail=50 --follow
```

### Debugging

```bash
# Describe a pod (shows events, conditions, mounts)
kubectl describe pod spark-streaming-xxx -n hk-bus

# Execute commands in a pod
kubectl exec -it kafka-0 -n hk-bus -- bash
kubectl exec -it postgres-0 -n hk-bus -- psql -U admin -d hk_bus

# Port forward
kubectl port-forward -n hk-bus svc/kafka-broker 9092:9092
kubectl port-forward -n hk-bus svc/postgres-db 5432:5432
kubectl port-forward -n hk-bus svc/grafana 3000:3000
```

### Cleanup

```bash
# Delete a pod (will be recreated by StatefulSet/Deployment)
kubectl delete pod spark-streaming-xxx -n hk-bus

# Restart a deployment
kubectl rollout restart deployment/grafana -n hk-bus

# Delete namespace and all resources in it
kubectl delete namespace hk-bus
```

---

## Expected Timeline

| Step | Time | Status |
|------|------|--------|
| Clone repo | 1 min | ✅ |
| Build Docker image | 5 min | ✅ |
| Deploy Zookeeper | 2 min | ✅ |
| Deploy Kafka | 3 min | ✅ |
| Deploy PostgreSQL | 3 min | ✅ |
| Deploy Spark | 2 min | ✅ |
| Deploy Grafana | 2 min | ✅ |
| Load dashboards | 1 min | ✅ |
| **Total** | **~20 min** | ✅ |

After deployment, test takes 1-2 minutes (for Spark to aggregate data into 1-minute windows).

---

## Next Steps

Once setup is complete:

1. **Automated Data Fetching** (Optional)
   - Deploy OpenFaaS and kmb-fetcher function
   - Configured in `k8s/openfaas/`
   - Fetches KMB API every minute

2. **View Analytics**
   - Access Grafana at http://localhost:3000
   - Check real-time and historical dashboards
   - Set up alerts

3. **Scale to Production**
   - Deploy to cloud Kubernetes cluster (EKS, GKE, AKS)
   - Add persistent storage for PostgreSQL
   - Configure authentication for Grafana
   - Set up monitoring and logging

---

## Support

For issues or questions:
1. Check the [Troubleshooting](#troubleshooting) section
2. Review logs: `kubectl logs <pod-name> -n hk-bus`
3. Check PIPELINE_STATUS.md for known issues and fixes

---

**Happy tracking! 🚌**
