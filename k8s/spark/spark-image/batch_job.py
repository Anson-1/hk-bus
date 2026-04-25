import os
import sys
from datetime import datetime, timedelta, timezone
import psycopg2
from psycopg2.extras import execute_values

def get_db_conn():
    return psycopg2.connect(
        host=os.environ.get("POSTGRES_HOST", "postgres-db.hk-bus.svc.cluster.local"),
        port=int(os.environ.get("POSTGRES_PORT", "5432")),
        dbname=os.environ.get("POSTGRES_DB", "hkbus"),
        user=os.environ.get("POSTGRES_USER", "postgres"),
        password=os.environ.get("POSTGRES_PASSWORD", "postgres"),
    )

def ensure_analytics_tables(conn):
    """Create analytics tables if they don't exist"""
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS eta_analytics (
                id SERIAL PRIMARY KEY,
                route VARCHAR(10) NOT NULL,
                direction VARCHAR(1),
                stop_id VARCHAR(100),
                hour_of_day INTEGER,
                day_of_week INTEGER,
                avg_wait_sec NUMERIC,
                min_wait_sec NUMERIC,
                max_wait_sec NUMERIC,
                p95_wait_sec NUMERIC,
                reliability_pct NUMERIC,
                on_time_pct NUMERIC,
                sample_count INTEGER,
                analysis_date DATE NOT NULL,
                computed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE INDEX IF NOT EXISTS idx_analytics_route_date
            ON eta_analytics(route, analysis_date DESC);
            
            CREATE INDEX IF NOT EXISTS idx_analytics_stop_date  
            ON eta_analytics(stop_id, analysis_date DESC);
        """)
    conn.commit()

def main():
    from pyspark.sql import SparkSession
    from pyspark.sql.functions import (
        col, hour, dayofweek, avg, min as spark_min, max as spark_max,
        percentile_approx, current_timestamp, to_date, when, sum as spark_sum,
        count as spark_count
    )
    from pyspark.sql.window import Window

    POSTGRES_HOST = os.environ.get("POSTGRES_HOST", "postgres-db.hk-bus.svc.cluster.local")
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

    print(f"[INFO] Starting Spark Batch Analytics Job (v2)", file=sys.stderr)
    print(f"[INFO] PostgreSQL: {POSTGRES_HOST}:{POSTGRES_PORT}/{POSTGRES_DB}", file=sys.stderr)

    try:
        spark = SparkSession.builder \
            .appName("ETABatchAnalytics") \
            .config("spark.jars.packages", "org.postgresql:postgresql:42.7.1") \
            .config("spark.sql.shuffle.partitions", "4") \
            .getOrCreate()
        spark.sparkContext.setLogLevel("WARN")
        print(f"[INFO] SparkSession created successfully", file=sys.stderr)
    except Exception as e:
        print(f"[ERROR] Failed to create SparkSession: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)

    try:
        # Read eta_processed data from last 24 hours (or whatever is available)
        processed_df = spark.read.jdbc(JDBC_URL, "eta_processed", properties=JDBC_PROPS) \
            .filter("processed_at >= NOW() - INTERVAL '24 hours'")
        
        print(f"[INFO] Loaded {processed_df.count()} processed records", file=sys.stderr)
        
        # Extract features for analytics
        analytics_df = processed_df \
            .withColumn("hour_of_day", hour(col("window_start"))) \
            .withColumn("day_of_week", dayofweek(col("window_start"))) \
            .withColumn("analysis_date", to_date(col("window_start"))) \
            .groupBy(
                col("route"), col("direction"), col("stop_id"),
                col("hour_of_day"), col("day_of_week"), col("analysis_date")
            ) \
            .agg(
                avg("avg_wait_sec").alias("avg_wait_sec"),
                spark_min("min_wait_sec").alias("min_wait_sec"),
                spark_max("max_wait_sec").alias("max_wait_sec"),
                percentile_approx("avg_wait_sec", 0.95).alias("p95_wait_sec"),
                when(avg("delay_flag") == False, 100.0).otherwise(100.0 - (avg("delay_flag") * 100.0))
                    .alias("reliability_pct"),
                spark_sum(when(col("avg_wait_sec") <= 600, 1).otherwise(0)) \
                    .cast("double") / spark_count("*") * 100 \
                    .alias("on_time_pct"),
                spark_sum("sample_count").alias("sample_count")
            ) \
            .select(
                col("route"),
                col("direction"),
                col("stop_id"),
                col("hour_of_day"),
                col("day_of_week"),
                col("avg_wait_sec"),
                col("min_wait_sec"),
                col("max_wait_sec"),
                col("p95_wait_sec"),
                col("reliability_pct"),
                col("on_time_pct"),
                col("sample_count"),
                col("analysis_date"),
                current_timestamp().alias("computed_at")
            )
        
        # Collect results and write to database
        rows = analytics_df.collect()
        if rows:
            conn = get_db_conn()
            ensure_analytics_tables(conn)
            
            data = []
            for row in rows:
                data.append((
                    row["route"],
                    row["direction"],
                    row["stop_id"],
                    int(row["hour_of_day"]),
                    int(row["day_of_week"]),
                    float(row["avg_wait_sec"]) if row["avg_wait_sec"] else None,
                    float(row["min_wait_sec"]) if row["min_wait_sec"] else None,
                    float(row["max_wait_sec"]) if row["max_wait_sec"] else None,
                    float(row["p95_wait_sec"]) if row["p95_wait_sec"] else None,
                    float(row["reliability_pct"]) if row["reliability_pct"] else None,
                    float(row["on_time_pct"]) if row["on_time_pct"] else None,
                    int(row["sample_count"]),
                    row["analysis_date"],
                ))
            
            with conn.cursor() as cur:
                execute_values(
                    cur,
                    """INSERT INTO eta_analytics 
                       (route, direction, stop_id, hour_of_day, day_of_week,
                        avg_wait_sec, min_wait_sec, max_wait_sec, p95_wait_sec,
                        reliability_pct, on_time_pct, sample_count, analysis_date)
                       VALUES %s
                    """,
                    data
                )
            conn.commit()
            conn.close()
            
            print(f"[INFO] Wrote {len(rows)} analytics records to PostgreSQL", file=sys.stderr)
        else:
            print(f"[INFO] No data to analyze", file=sys.stderr)

    except Exception as e:
        print(f"[ERROR] Batch job failed: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

