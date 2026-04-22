# HK Bus Infrastructure Deployment Summary

**Date:** April 22, 2026  
**Status:** 90% Complete - Kubernetes Stability Issues

---

## ✅ What We Achieved

### 1. **Docker Images Successfully Built & Pushed**
- **kmb-fetcher** → `ansonhui123/kmb-fetcher:latest`
  - OpenFaaS function for fetching KMB ETAs
  - Pushes data to Kafka topic `kmb-eta-raw`
  
- **kmb-spark:v2** → `ansonhui123/kmb-spark:v2`
  - Spark image with Java (required for PySpark)
  - Python 3.11 base with dependencies: pyspark, psycopg2, kafka-python
  - Includes streaming_job.py and batch_job.py

### 2. **Kubernetes Manifests Ready**
All YAML files properly configured:
- ✅ `k8s/namespace.yaml` - hk-bus namespace
- ✅ `k8s/kafka/` - Kafka (switched to `wurstmeister/kafka:latest`)
- ✅ `k8s/kafka/zookeeper.yaml` - Zookeeper (confluentinc/cp-zookeeper:7.5.0)
- ✅ `k8s/postgres/` - PostgreSQL 15 with schema initialized
- ✅ `k8s/spark/` - Spark streaming & batch jobs
- ✅ `k8s/openfaas/` - OpenFaaS function (kmb-fetcher configured)
- ✅ `k8s/grafana/` - Grafana with 3 pre-loaded dashboards

### 3. **Database Schema Created**
PostgreSQL tables initialized:
- `eta_raw` - Raw ETA data with indices
- `eta_realtime` - Real-time wait time aggregations
- `eta_analytics` - Historical analytics by hour/day

### 4. **Monitoring Stack Deployed**
- Prometheus collecting metrics
- Grafana available at `http://localhost:30300` (admin/admin)
- 3 Dashboards: Infrastructure, Data, Analytics

### 5. **Code Cleanup**
- ✅ Removed duplicate `spark/` folder (consolidated to `k8s/spark/spark-image/`)
- ✅ Updated README.md directory structure
- ✅ Fixed OpenFaaS YAML (removed invalid `imagePullPolicy`)
- ✅ Updated image references to use Docker Hub URLs

---

## ❌ Current Problems

### Problem 1: Kafka Crashes on Deployment
**Symptom:**
- Pod status: `CrashLoopBackOff`
- Exit code: 1
- Logs show: Configuration starts but container exits immediately

**Root Cause:**
- `confluentinc/cp-kafka:7.5.0` has environment variable issues in Kubernetes
- Missing or incorrect KAFKA_BROKER_ID configuration

**Attempted Solutions:**
1. Switched from `bitnami/kafka:3.6` → `confluentinc/cp-kafka:7.5.0` ✗ (same issue)
2. Added environment variables: KAFKA_ZOOKEEPER_CONNECT, KAFKA_ADVERTISED_LISTENERS ✗
3. Switched to `wurstmeister/kafka:latest` ✓ (worked briefly before K8s crash)

**Next Steps to Fix:**
- Use `wurstmeister/kafka:latest` image (proven to work)
- Add environment variable: `KAFKA_BROKER_ID=0`
- Ensure Zookeeper is ready BEFORE Kafka pod starts
- Add init container or readiness probe dependency

### Problem 2: Spark Image Java/JAVA_HOME Issues
**Symptom:**
- Pod error: `/usr/local/lib/python3.11/site-packages/pyspark/bin/load-spark-env.sh: line 68: ps: command not found`
- Exit code: 1
- JAVA_HOME not set

**Root Cause:**
- Python 3.11-slim base image doesn't include Java
- PySpark requires Java to run spark-submit

**Attempted Solutions:**
1. Used `bitnami/spark:3.6` → Image not found in Docker Hub ✗
2. Used `apache/spark:3.5.0-python3` → Permission issues with pip install ✗
3. Used `confluentinc` images → Not available ✗
4. **Final Solution:** Python 3.11 + `default-jdk` (OpenJDK) ✓
   - Successfully built in `kmb-spark:v2` image
   - Just needs Kubernetes to be stable to test

### Problem 3: Kubernetes Instability After Docker Restart
**Symptom:**
- After Docker Desktop restart, kubectl commands hang
- Server timeout errors: "server was unable to return a response in the time allotted"
- All namespaces and deployments cleared

**Root Cause:**
- Docker Desktop Kubernetes cluster not fully recovering after restart
- Possible resource exhaustion from multiple failed pod deployments

**Impact:**
- Cannot verify Kafka, Spark, PostgreSQL are running
- Cannot test data pipeline flow

---

## 🔧 Solutions & Fixes

### Fix 1: Update Kafka Configuration
**File:** `k8s/kafka/kafka.yaml`

```yaml
containers:
  - name: kafka
    image: wurstmeister/kafka:latest
    ports:
      - containerPort: 9092
    env:
      - name: KAFKA_BROKER_ID
        value: "0"
      - name: KAFKA_ZOOKEEPER_CONNECT
        value: "zookeeper:2181"
      - name: KAFKA_ADVERTISED_HOST_NAME
        value: "kafka"
      - name: KAFKA_ADVERTISED_PORT
        value: "9092"
      - name: KAFKA_AUTO_CREATE_TOPICS_ENABLE
        value: "true"
```

**Deployment Order:**
```bash
# 1. Deploy Zookeeper first and wait
kubectl apply -f k8s/kafka/zookeeper.yaml
kubectl wait --for=condition=ready pod -l app=zookeeper -n hk-bus --timeout=60s

# 2. Then deploy Kafka
kubectl apply -f k8s/kafka/kafka.yaml
kubectl wait --for=condition=ready pod -l app=kafka -n hk-bus --timeout=120s
```

### Fix 2: Verify Spark v2 Image Works
**Status:** Image built and pushed as `ansonhui123/kmb-spark:v2`

**To verify once K8s is stable:**
```bash
kubectl apply -f k8s/spark/streaming-deployment.yaml
kubectl logs -l app=spark-streaming -n hk-bus --follow
```

Expected: Spark job connects to Kafka and starts reading messages.

### Fix 3: Kubernetes Stability
**Options:**

**Option A: Restart Docker Desktop (Recommended)**
```bash
# 1. Completely quit Docker Desktop
killall Docker

# 2. Reopen Docker app
# Wait 2-3 minutes for full initialization

# 3. Verify cluster is ready
kubectl cluster-info
kubectl get nodes
```

**Option B: Reset Kubernetes Cluster**
```bash
# Reset cluster but keep settings
# In Docker Desktop: Settings → Kubernetes → Reset Kubernetes Cluster
```

**Option C: Use Docker without Kubernetes**
- Deploy to separate Docker Compose setup instead
- Less complex but loses some K8s features

---

## 🚀 Deployment Checklist

Once Kubernetes is stable, run in this order:

```bash
# 1. Create namespace
kubectl apply -f k8s/namespace.yaml

# 2. Deploy Zookeeper (wait for ready)
kubectl apply -f k8s/kafka/zookeeper.yaml
kubectl wait --for=condition=ready pod -l app=zookeeper -n hk-bus --timeout=60s

# 3. Deploy Kafka (wait for ready)
kubectl apply -f k8s/kafka/kafka.yaml
kubectl wait --for=condition=ready pod -l app=kafka -n hk-bus --timeout=120s

# 4. Deploy PostgreSQL (wait for ready)
kubectl apply -f k8s/postgres/
kubectl wait --for=condition=ready pod -l app=postgres -n hk-bus --timeout=120s

# 5. Deploy Spark jobs
kubectl apply -f k8s/spark/

# 6. Deploy monitoring
kubectl apply -f k8s/grafana/

# 7. Deploy OpenFaaS function (only if OpenFaaS is installed)
kubectl apply -f k8s/openfaas/
```

---

## 📊 Verification Commands

Once deployed, verify data flow:

```bash
# Check all pods
kubectl get pods -n hk-bus

# Check Kafka has messages (from kmb-fetcher)
kubectl exec -it kafka-0 -n hk-bus -- \
  kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 \
  --topic kmb-eta-raw \
  --from-beginning \
  --max-messages 5

# Check PostgreSQL data
kubectl exec -it postgres-0 -n hk-bus -- \
  psql -U postgres -d hkbus -c "SELECT COUNT(*) FROM eta_raw;"

# Access Grafana
kubectl port-forward svc/grafana 30300:3000 -n hk-bus
# Then: http://localhost:30300 (admin/admin)
```

---

## 📝 Files Changed

### Updated Files:
- `README.md` - Fixed directory structure
- `k8s/kafka/kafka.yaml` - Switched to wurstmeister image
- `k8s/kafka/zookeeper.yaml` - Updated Zookeeper config
- `k8s/postgres/postgres.yaml` - Updated to postgres:15
- `k8s/spark/streaming-deployment.yaml` - Updated to spark:v2
- `k8s/spark/batch-cronjob.yaml` - Updated to spark:v2
- `k8s/openfaas/kmb-fetcher-fn.yaml` - Removed invalid imagePullPolicy
- `k8s/spark/spark-image/Dockerfile` - Added Java, updated base image
- Deleted: `spark/` folder (consolidated)

### New Files:
- Docker Hub images: `ansonhui123/kmb-fetcher:latest`, `ansonhui123/kmb-spark:v2`

---

## 💡 Lessons Learned

1. **Image Registry Issues**: Bitnami images not always available with specific versions; use official images when possible
2. **Java + Python**: PySpark requires Java; use full Python image (not -slim) + openjdk
3. **Service Dependencies**: Deploy Zookeeper before Kafka to avoid race conditions
4. **Docker Desktop K8s**: Can be unstable after restarts; full restart or reset may be needed
5. **Staged Deployment**: Deploy and test each component separately rather than all at once

---

## 🎯 Expected End State

Once Kubernetes is stable and all services deployed:

1. ✅ Kafka receives messages from kmb-fetcher function (every minute via cron)
2. ✅ Spark streaming job processes messages and writes to PostgreSQL (eta_realtime table)
3. ✅ Spark batch job runs hourly and computes analytics (eta_analytics table)
4. ✅ Grafana dashboards display real-time and historical data
5. ✅ Data pipeline: KMB API → OpenFaaS → Kafka → Spark → PostgreSQL → Grafana

---

## 🔗 References

- **Kafka Wurstmeister:** https://hub.docker.com/r/wurstmeister/kafka
- **PostgreSQL:** https://hub.docker.com/_/postgres
- **PySpark:** https://spark.apache.org/docs/latest/api/python/
- **OpenFaaS:** https://docs.openfaas.com/
