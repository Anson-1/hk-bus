import os
import statistics
from datetime import datetime, timezone


# ── Pure functions (unit-testable) ───────────────────────────────────────────

def compute_p95(values: list):
    if not values:
        return None
    sorted_vals = sorted(values)
    idx = int(len(sorted_vals) * 0.95)
    idx = min(idx, len(sorted_vals) - 1)
    return sorted_vals[idx]


def build_analytics_row(route: str, hour_of_day: int, day_of_week: int,
                        wait_values: list) -> dict:
    avg = statistics.mean(wait_values) if wait_values else None
    p95 = compute_p95(wait_values)
    return {
        "route": route,
        "hour_of_day": hour_of_day,
        "day_of_week": day_of_week,
        "avg_wait_sec": avg,
        "p95_wait_sec": p95,
        "computed_at": datetime.now(timezone.utc).isoformat(),
    }


# ── Spark entry point ─────────────────────────────────────────────────────────

def main():
    from pyspark.sql import SparkSession
    from pyspark.sql.functions import (
        col, hour, dayofweek, avg, percentile_approx, current_timestamp
    )

    POSTGRES_HOST = os.environ.get("POSTGRES_HOST", "postgres")
    POSTGRES_PORT = os.environ.get("POSTGRES_PORT", "5432")
    POSTGRES_DB = os.environ.get("POSTGRES_DB", "hkbus")
    POSTGRES_USER = os.environ.get("POSTGRES_USER", "postgres")
    POSTGRES_PASSWORD = os.environ.get("POSTGRES_PASSWORD", "postgres")
    JDBC_URL = f"jdbc:postgresql://{POSTGRES_HOST}:{POSTGRES_PORT}/{POSTGRES_DB}"
    JDBC_PROPS = {
        "user": POSTGRES_USER,
        "password": POSTGRES_PASSWORD,
        "driver": "org.postgresql.Driver",
    }

    spark = SparkSession.builder \
        .appName("KMBBatchJob") \
        .config("spark.jars.packages", "org.postgresql:postgresql:42.7.1") \
        .getOrCreate()
    spark.sparkContext.setLogLevel("WARN")

    raw_df = spark.read.jdbc(JDBC_URL, "eta_raw", properties=JDBC_PROPS) \
        .filter("fetched_at >= NOW() - INTERVAL '7 days'") \
        .filter("eta IS NOT NULL") \
        .withColumn("wait_sec",
            (col("eta").cast("double") - col("data_timestamp").cast("double"))) \
        .filter("wait_sec >= 0 AND wait_sec < 7200") \
        .withColumn("hour_of_day", hour(col("fetched_at"))) \
        .withColumn("day_of_week", dayofweek(col("fetched_at")) - 2)  # 0=Mon

    analytics_df = raw_df.groupBy("route", "hour_of_day", "day_of_week") \
        .agg(
            avg("wait_sec").alias("avg_wait_sec"),
            percentile_approx("wait_sec", 0.95).alias("p95_wait_sec"),
            current_timestamp().alias("computed_at")
        )

    analytics_df.write.jdbc(
        JDBC_URL, "eta_analytics", mode="append", properties=JDBC_PROPS
    )

    print(f"Batch job complete: {analytics_df.count()} rows written to eta_analytics")


if __name__ == "__main__":
    main()
