import json
import os
from datetime import datetime
import sys
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

def ensure_tables(conn):
    """Create eta_processed table if it doesn't exist"""
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS eta_processed (
                id SERIAL PRIMARY KEY,
                route VARCHAR(10) NOT NULL,
                direction VARCHAR(1) NOT NULL,
                stop_id VARCHAR(100) NOT NULL,
                window_start TIMESTAMP NOT NULL,
                window_end TIMESTAMP NOT NULL,
                avg_wait_sec NUMERIC,
                min_wait_sec NUMERIC,
                max_wait_sec NUMERIC,
                delay_flag BOOLEAN,
                sample_count INTEGER,
                processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(route, direction, stop_id, window_start)
            );
            
            CREATE INDEX IF NOT EXISTS idx_processed_route_time 
            ON eta_processed(route, direction, window_start DESC);
            
            CREATE INDEX IF NOT EXISTS idx_processed_stop_time 
            ON eta_processed(stop_id, window_start DESC);
        """)
    conn.commit()

def main():
    try:
        from pyspark.sql import SparkSession
        from pyspark.sql.functions import (
            from_json, col, window, avg, min as spark_min, max as spark_max,
            count as spark_count, when, to_timestamp
        )
        from pyspark.sql.types import (
            StructType, StructField, StringType, IntegerType, DoubleType, BooleanType
        )

        KAFKA_BROKERS = os.environ.get("KAFKA_BROKERS", "kafka-broker.hk-bus.svc.cluster.local:9092")
        KAFKA_TOPIC = os.environ.get("KAFKA_TOPIC", "eta-events")

        print(f"[INFO] Starting Spark Streaming Job (v2)", file=sys.stderr)
        print(f"[INFO] Kafka Brokers: {KAFKA_BROKERS}", file=sys.stderr)
        print(f"[INFO] Kafka Topic: {KAFKA_TOPIC}", file=sys.stderr)

        try:
            spark = SparkSession.builder \
                .appName("ETAStreamingProcessing") \
                .config("spark.jars.packages",
                        "org.apache.spark:spark-sql-kafka-0-10_2.12:3.5.0") \
                .config("spark.sql.adaptive.enabled", "false") \
                .getOrCreate()
            print(f"[INFO] SparkSession created successfully", file=sys.stderr)
        except Exception as e:
            print(f"[ERROR] Failed to create SparkSession: {e}", file=sys.stderr)
            raise

        schema = StructType([
            StructField("route", StringType()),
            StructField("direction", StringType()),
            StructField("stopId", StringType()),
            StructField("waitSeconds", IntegerType()),
            StructField("delayFlag", BooleanType()),
            StructField("timestamp", StringType()),
        ])

        print(f"[INFO] Reading from Kafka topic: {KAFKA_TOPIC}", file=sys.stderr)
        try:
            raw_df = spark.readStream \
                .format("kafka") \
                .option("kafka.bootstrap.servers", KAFKA_BROKERS) \
                .option("subscribe", KAFKA_TOPIC) \
                .option("startingOffsets", "latest") \
                .option("failOnDataLoss", "false") \
                .load() \
                .select(from_json(col("value").cast("string"), schema).alias("data")) \
                .select("data.*") \
                .withColumn("event_time", to_timestamp(col("timestamp")))
            print(f"[INFO] Kafka stream loaded successfully", file=sys.stderr)
        except Exception as e:
            print(f"[ERROR] Failed to read from Kafka: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)
            raise

        agg_df = raw_df \
            .withWatermark("event_time", "1 minute") \
            .groupBy(
                window(col("event_time"), "5 minutes"),
                col("route"), col("direction"), col("stopId")
            ) \
            .agg(
                avg("waitSeconds").alias("avg_wait_sec"),
                spark_min("waitSeconds").alias("min_wait_sec"),
                spark_max("waitSeconds").alias("max_wait_sec"),
                when(avg("waitSeconds") > 600, True).otherwise(False).alias("delay_flag"),
                spark_count("*").alias("sample_count")
            ) \
            .select(
                col("route"),
                col("direction"),
                col("stopId"),
                col("window.start").alias("window_start"),
                col("window.end").alias("window_end"),
                col("avg_wait_sec"),
                col("min_wait_sec"),
                col("max_wait_sec"),
                col("delay_flag"),
                col("sample_count")
            )

        def write_batch(batch_df, batch_id):
            """Write aggregated batch to PostgreSQL with proper type handling"""
            try:
                rows = batch_df.collect()
                if not rows:
                    print(f"[DEBUG] Batch {batch_id}: No rows to process", file=sys.stderr)
                    return
                
                print(f"[DEBUG] Batch {batch_id}: Processing {len(rows)} rows", file=sys.stderr)
                conn = get_db_conn()
                ensure_tables(conn)
                
                data = []
                for i, row in enumerate(rows):
                    try:
                        # Convert Spark types to Python native types for psycopg2
                        route = str(row["route"]) if row["route"] else ""
                        direction = str(row["direction"]) if row["direction"] else ""
                        stop_id = str(row["stopId"]) if row["stopId"] else ""
                        window_start = row["window_start"]  # Already a Python datetime from Spark SQL
                        window_end = row["window_end"]  # Already a Python datetime
                        
                        # Handle numeric values - convert Decimal to float if needed
                        avg_wait = None
                        if row["avg_wait_sec"] is not None:
                            avg_wait = float(row["avg_wait_sec"])
                        
                        min_wait = None
                        if row["min_wait_sec"] is not None:
                            min_wait = float(row["min_wait_sec"])
                        
                        max_wait = None
                        if row["max_wait_sec"] is not None:
                            max_wait = float(row["max_wait_sec"])
                        
                        delay = bool(row["delay_flag"]) if row["delay_flag"] is not None else False
                        sample_count = int(row["sample_count"]) if row["sample_count"] else 0
                        
                        data.append((
                            route,
                            direction,
                            stop_id,
                            window_start,
                            window_end,
                            avg_wait,
                            min_wait,
                            max_wait,
                            delay,
                            sample_count
                        ))
                    except Exception as e:
                        print(f"[ERROR] Batch {batch_id}, Row {i}: Failed to convert types - {e}", file=sys.stderr)
                        print(f"[DEBUG] Row data: {dict(row)}", file=sys.stderr)
                        raise
                
                # Write to database
                with conn.cursor() as cur:
                    try:
                        execute_values(
                            cur,
                            """INSERT INTO eta_processed 
                               (route, direction, stop_id, window_start, window_end, 
                                avg_wait_sec, min_wait_sec, max_wait_sec, delay_flag, sample_count)
                               VALUES %s
                               ON CONFLICT (route, direction, stop_id, window_start) 
                               DO UPDATE SET
                                   avg_wait_sec = EXCLUDED.avg_wait_sec,
                                   min_wait_sec = EXCLUDED.min_wait_sec,
                                   max_wait_sec = EXCLUDED.max_wait_sec,
                                   delay_flag = EXCLUDED.delay_flag,
                                   sample_count = EXCLUDED.sample_count,
                                   processed_at = CURRENT_TIMESTAMP
                            """,
                            data
                        )
                        print(f"[DEBUG] Batch {batch_id}: Execute completed, affected rows: {cur.rowcount}", file=sys.stderr)
                    except Exception as e:
                        print(f"[ERROR] Batch {batch_id}: Database insert failed - {e}", file=sys.stderr)
                        raise
                
                conn.commit()
                conn.close()
                print(f"[INFO] Batch {batch_id}: Successfully wrote {len(rows)} aggregated records to PostgreSQL", file=sys.stderr)
                
            except Exception as e:
                print(f"[ERROR] Batch {batch_id}: Failed - {e}", file=sys.stderr)
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
            import traceback
            traceback.print_exc(file=sys.stderr)

    except Exception as e:
        print(f"[ERROR] Main error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
