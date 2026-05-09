"""
KMB ETA Spark Analysis Job
Reads from kmb.eta (PostgreSQL), computes delay analytics, writes results back.
Runs in local[*] mode on the EC2 node — same code works on a full Spark cluster
by changing spark.master to spark://<host>:7077.
"""

import os
import sys
from pyspark.sql import SparkSession
from pyspark.sql import functions as F

JDBC_URL  = os.getenv("JDBC_URL", "jdbc:postgresql://postgres-db.hk-bus.svc.cluster.local:5432/hkbus")
JDBC_PROPS = {
    "user":     os.getenv("DB_USER",     "postgres"),
    "password": os.getenv("DB_PASSWORD", "postgres"),
    "driver":   "org.postgresql.Driver",
}
JDBC_JAR = os.getenv("JDBC_JAR", "/opt/spark-jobs/postgresql.jar")

spark = SparkSession.builder \
    .appName("KMB ETA Analysis") \
    .master("local[*]") \
    .config("spark.driver.memory", "4g") \
    .config("spark.sql.shuffle.partitions", "8") \
    .config("spark.jars", JDBC_JAR) \
    .config("spark.driver.host", "127.0.0.1") \
    .config("spark.driver.bindAddress", "127.0.0.1") \
    .config("spark.network.timeout", "600s") \
    .config("spark.executor.heartbeatInterval", "60s") \
    .getOrCreate()

spark.sparkContext.setLogLevel("WARN")

# ── Read kmb.eta ───────────────────────────────────────────────
print("[KMB Analysis] Reading kmb.eta from PostgreSQL...")

# Push eta_seq=1 and wait_minutes filter to PostgreSQL to reduce transfer
ETA_QUERY = (
    "(SELECT * FROM kmb.eta "
    " WHERE eta_seq = 1 AND wait_minutes >= 0"
    " AND fetched_at >= '2025-05-08 00:00:00'"
    " AND fetched_at <  '2025-05-09 00:00:00'"
    ") AS eta_next"
)

df_clean = spark.read.jdbc(
    JDBC_URL, ETA_QUERY,
    column="hour_of_day",
    lowerBound=0,
    upperBound=23,
    numPartitions=8,
    properties=JDBC_PROPS,
)

total = df_clean.count()
print(f"[KMB Analysis] Total next-bus records: {total:,}")

# ── 1. Route analytics — avg / P95 wait by route + hour ───────
print("[KMB Analysis] Computing route analytics (avg/P95 per route+hour)...")
route_analytics = df_clean \
    .groupBy("route", "hour_of_day") \
    .agg(
        F.round(F.avg("wait_minutes"),                              2).alias("avg_wait_minutes"),
        F.round(F.expr("percentile_approx(wait_minutes, 0.95)"),   2).alias("p95_wait_minutes"),
        F.round(F.stddev("wait_minutes"),                          2).alias("stddev_wait_minutes"),
        F.count("*").alias("sample_count"),
    )

# ── 2. Peak hours — avg wait by hour across all routes ─────────
print("[KMB Analysis] Computing peak hour patterns...")
peak_hours = df_clean \
    .groupBy("hour_of_day") \
    .agg(
        F.round(F.avg("wait_minutes"),  2).alias("avg_wait_minutes"),
        F.round(F.expr("percentile_approx(wait_minutes, 0.95)"), 2).alias("p95_wait_minutes"),
        F.count("*").alias("sample_count"),
    ) \
    .orderBy("hour_of_day")

# ── 3. Route reliability — overall metrics per route ──────────
print("[KMB Analysis] Computing route reliability...")
route_reliability = df_clean \
    .groupBy("route") \
    .agg(
        F.round(F.avg("wait_minutes"),                            2).alias("avg_wait_minutes"),
        F.round(F.expr("percentile_approx(wait_minutes, 0.95)"), 2).alias("p95_wait_minutes"),
        F.round(F.stddev("wait_minutes"),                        2).alias("stddev_wait_minutes"),
        F.count("*").alias("sample_count"),
    ) \
    .withColumn(
        # reliability score: lower stddev relative to avg = more reliable
        "reliability_score",
        F.round(
            F.when(F.col("avg_wait_minutes") > 0,
                   F.greatest(F.lit(0.0), 1 - (F.col("stddev_wait_minutes") / (F.col("avg_wait_minutes") + 1)))
            ).otherwise(0),
            4
        )
    )

# ── Write results ─────────────────────────────────────────────
print("[KMB Analysis] Writing results to PostgreSQL...")

# Cache before write so .count() doesn't re-trigger full computation
route_analytics.cache()
peak_hours.cache()
route_reliability.cache()

# Ensure kmb schema exists (Spark JDBC won't auto-create schemas)
import psycopg2, urllib.parse
_parsed = urllib.parse.urlparse(JDBC_URL.replace("jdbc:", ""))
_conn = psycopg2.connect(
    host=_parsed.hostname, port=_parsed.port or 5432,
    dbname=_parsed.path.lstrip("/"),
    user=JDBC_PROPS["user"], password=JDBC_PROPS["password"],
)
_conn.autocommit = True
_cur = _conn.cursor()
_cur.execute("CREATE SCHEMA IF NOT EXISTS kmb")
_cur.close()
_conn.close()

route_analytics.write.jdbc(
    JDBC_URL, "kmb.spark_analytics",
    mode="overwrite",
    properties=JDBC_PROPS,
)
print(f"  kmb.spark_analytics: {route_analytics.count():,} rows")

peak_hours.write.jdbc(
    JDBC_URL, "kmb.spark_peak_hours",
    mode="overwrite",
    properties=JDBC_PROPS,
)
print(f"  kmb.spark_peak_hours: {peak_hours.count():,} rows")

route_reliability.write.jdbc(
    JDBC_URL, "kmb.spark_route_reliability",
    mode="overwrite",
    properties=JDBC_PROPS,
)
print(f"  kmb.spark_route_reliability: {route_reliability.count():,} rows")

print("[KMB Analysis] All done.")
spark.stop()
sys.exit(0)
