import json
import os
from datetime import datetime
from dateutil import parser as dtparser
import psycopg2

# ── Pure transformation functions (unit-testable without Spark) ──────────────

def compute_wait_seconds(eta_str: str, data_ts_str: str):
    """Return seconds between data_timestamp and eta. None if eta is null/empty."""
    if not eta_str:
        return None
    try:
        eta = dtparser.parse(eta_str)
        data_ts = dtparser.parse(data_ts_str)
        return (eta - data_ts).total_seconds()
    except Exception:
        return None


def compute_delay_flag(avg_wait_sec) -> float:
    """Return 1.0 if average wait exceeds 10 minutes, 0.0 otherwise."""
    if avg_wait_sec is None:
        return 0.0
    return 1.0 if avg_wait_sec > 600 else 0.0


def parse_eta_record(record: dict) -> dict:
    wait = compute_wait_seconds(record.get("eta"), record.get("data_timestamp"))
    return {
        "co": record.get("co"),
        "route": record.get("route"),
        "dir": record.get("dir"),
        "stop": record.get("stop"),
        "eta_seq": record.get("eta_seq"),
        "eta": record.get("eta"),
        "rmk_en": record.get("rmk_en", ""),
        "data_timestamp": record.get("data_timestamp"),
        "fetched_at": record.get("fetched_at"),
        "wait_sec": wait,
    }


# ── Database helpers ─────────────────────────────────────────────────────────

def get_db_conn():
    return psycopg2.connect(
        host=os.environ.get("POSTGRES_HOST", "postgres"),
        port=int(os.environ.get("POSTGRES_PORT", "5432")),
        dbname=os.environ.get("POSTGRES_DB", "hkbus"),
        user=os.environ.get("POSTGRES_USER", "postgres"),
        password=os.environ.get("POSTGRES_PASSWORD", "postgres"),
    )


def write_raw(conn, record: dict):
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO eta_raw (co, route, dir, stop, eta_seq, eta, rmk_en, data_timestamp, fetched_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (record["co"], record["route"], record["dir"], record["stop"],
             record["eta_seq"], record["eta"], record["rmk_en"],
             record["data_timestamp"], record["fetched_at"])
        )
    conn.commit()


def write_realtime(conn, route: str, dir_: str, window_start: str,
                   avg_wait: float, avg_delay_flag: float, count: int):
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO eta_realtime (route, dir, window_start, avg_wait_sec, avg_delay_flag, sample_count)
               VALUES (%s,%s,%s,%s,%s,%s)
               ON CONFLICT (route, dir, window_start) DO UPDATE
               SET avg_wait_sec=EXCLUDED.avg_wait_sec,
                   avg_delay_flag=EXCLUDED.avg_delay_flag,
                   sample_count=EXCLUDED.sample_count""",
            (route, dir_, window_start, avg_wait, avg_delay_flag, count)
        )
    conn.commit()


# ── Spark entry point ─────────────────────────────────────────────────────────

def main():
    import sys
    from pyspark.sql import SparkSession
    from pyspark.sql.functions import (
        from_json, col, window, avg, count as spark_count,
        udf, to_timestamp
    )
    from pyspark.sql.types import (
        StructType, StructField, StringType, IntegerType, DoubleType
    )

    KAFKA_BROKER = os.environ.get("KAFKA_BROKER", "kafka:9092")
    KAFKA_TOPIC = os.environ.get("KAFKA_TOPIC", "kmb-eta-raw")

    print(f"[INFO] Starting Spark Streaming Job", file=sys.stderr)
    print(f"[INFO] Kafka Broker: {KAFKA_BROKER}", file=sys.stderr)
    print(f"[INFO] Kafka Topic: {KAFKA_TOPIC}", file=sys.stderr)

    try:
        spark = SparkSession.builder \
            .appName("KMBStreamingJob") \
            .config("spark.jars.packages",
                    "org.apache.spark:spark-sql-kafka-0-10_2.12:3.5.0,"
                    "org.postgresql:postgresql:42.7.1") \
            .getOrCreate()
        spark.sparkContext.setLogLevel("WARN")
        print(f"[INFO] SparkSession created successfully", file=sys.stderr)
    except Exception as e:
        print(f"[ERROR] Failed to create SparkSession: {e}", file=sys.stderr)
        sys.exit(1)

    schema = StructType([
        StructField("co", StringType()),
        StructField("route", StringType()),
        StructField("dir", StringType()),
        StructField("service_type", StringType()),
        StructField("seq", IntegerType()),
        StructField("stop", StringType()),
        StructField("dest_en", StringType()),
        StructField("eta_seq", IntegerType()),
        StructField("eta", StringType()),
        StructField("rmk_en", StringType()),
        StructField("data_timestamp", StringType()),
        StructField("fetched_at", StringType()),
    ])

    wait_udf = udf(compute_wait_seconds, DoubleType())

    print(f"[INFO] Reading from Kafka topic: {KAFKA_TOPIC}", file=sys.stderr)
    try:
        raw_df = spark.readStream \
            .format("kafka") \
            .option("kafka.bootstrap.servers", KAFKA_BROKER) \
            .option("subscribe", KAFKA_TOPIC) \
            .option("startingOffsets", "earliest") \
            .load() \
            .select(from_json(col("value").cast("string"), schema).alias("d")) \
            .select("d.*") \
            .withColumn("wait_sec", wait_udf(col("eta"), col("data_timestamp"))) \
            .withColumn("event_time", to_timestamp(col("data_timestamp")))
        print(f"[INFO] Kafka stream loaded successfully", file=sys.stderr)
    except Exception as e:
        print(f"[ERROR] Failed to load Kafka stream: {e}", file=sys.stderr)
        sys.exit(1)

    agg_df = raw_df \
        .withWatermark("event_time", "2 minutes") \
        .groupBy(
            window(col("event_time"), "1 minute"),
            col("route"), col("dir")
        ) \
        .agg(
            avg("wait_sec").alias("avg_wait_sec"),
            spark_count("*").alias("sample_count")
        )

    def write_batch(batch_df, batch_id):
        try:
            rows = batch_df.collect()
            if rows:
                conn = get_db_conn()
                for row in rows:
                    avg_w = row["avg_wait_sec"]
                    flag = compute_delay_flag(avg_w)
                    write_realtime(conn, row["route"], row["dir"],
                                   str(row["window"]["start"]), avg_w, flag, row["sample_count"])
                conn.close()
                print(f"[INFO] Wrote {len(rows)} records to PostgreSQL", file=sys.stderr)
        except Exception as e:
            print(f"[ERROR] Failed to write batch: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)

    print(f"[INFO] Starting streaming query", file=sys.stderr)
    try:
        query = agg_df.writeStream \
            .foreachBatch(write_batch) \
            .outputMode("update") \
            .trigger(processingTime="30 seconds") \
            .start()
        print(f"[INFO] Stream query started, awaiting termination...", file=sys.stderr)
        query.awaitTermination()
    except Exception as e:
        print(f"[ERROR] Streaming query failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
