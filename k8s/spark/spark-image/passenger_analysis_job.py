"""
Spark batch job: HK Cross-Border Passenger Flow Analysis
Reads IMMD daily passenger CSV (2021-present) + HK public holiday JSON,
classifies each day as Weekday/Weekend/Public Holiday/Lunar New Year,
aggregates and writes to passenger_daily_summary table.

Run:
    python passenger_analysis_job.py

Requires:
    pip install pyspark requests psycopg2-binary
"""

import os
import io
import json
import datetime
import requests
import psycopg2
from psycopg2.extras import execute_values
from pyspark.sql import SparkSession
from pyspark.sql.functions import (
    col, to_date, year, month, dayofweek, sum as spark_sum,
    avg, udf, lit, when
)
from pyspark.sql.types import StringType

# ── Config ───────────────────────────────────────────────────────────────────
DB = {
    "host": os.getenv("POSTGRES_HOST", "localhost"),
    "port": int(os.getenv("POSTGRES_PORT", 5432)),
    "dbname": os.getenv("POSTGRES_DB", "hk_bus"),
    "user": os.getenv("POSTGRES_USER", "postgres"),
    "password": os.getenv("POSTGRES_PASSWORD", "postgres"),
}

IMMD_CSV_URL = ("https://www.immd.gov.hk/opendata/eng/transport/"
                "immigration_clearance/statistics_on_daily_passenger_traffic.csv")
HOLIDAY_JSON_URL = "https://www.1823.gov.hk/common/ical/en.json"

LUNAR_NEW_YEAR_DATES = {
    # Year: (start_date, end_date) of Lunar New Year holiday period
    "2021": ("2021-02-11", "2021-02-17"),
    "022":  ("2022-02-01", "2022-02-07"),
    "2023": ("2023-01-22", "2023-01-28"),
    "2024": ("2024-02-10", "2024-02-16"),
    "2025": ("2025-01-29", "2025-02-04"),
    "2026": ("2026-02-17", "2026-02-23"),
}


# ── Fetch helpers ─────────────────────────────────────────────────────────────
def fetch_holiday_set() -> tuple[set, set]:
    """Returns (all_holiday_dates, lunar_new_year_dates) as sets of 'YYYY-MM-DD' strings."""
    r = requests.get(HOLIDAY_JSON_URL, timeout=30)
    r.raise_for_status()
    data = r.json()

    holidays = {}  # date_str -> summary
    for item in data.get("vcalendar", [{}])[0].get("vevent", []):
        # dtstart is a list like ["20240101", {"value": "DATE"}]
        dtstart = item.get("dtstart", [])
        raw = dtstart[0] if dtstart else None
        summary = item.get("summary", "Public Holiday")
        if raw and len(str(raw)) == 8:
            s = str(raw)
            date_str = f"{s[:4]}-{s[4:6]}-{s[6:]}"
            holidays[date_str] = summary

    lunar_dates = set()
    for yr, (start, end) in LUNAR_NEW_YEAR_DATES.items():
        d = datetime.date.fromisoformat(start)
        end_d = datetime.date.fromisoformat(end)
        while d <= end_d:
            lunar_dates.add(d.isoformat())
            d += datetime.timedelta(days=1)

    print(f"[INFO] Loaded {len(holidays)} public holidays, {len(lunar_dates)} Lunar New Year dates")
    return set(holidays.keys()), lunar_dates, holidays


def fetch_immd_text() -> str:
    r = requests.get(IMMD_CSV_URL, timeout=60)
    r.raise_for_status()
    return r.text


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    print("[INFO] Starting Passenger Flow Analysis Spark Job")

    holidays, lunar_dates, holiday_names = fetch_holiday_set()

    # Broadcast sets to Spark workers
    spark = SparkSession.builder \
        .appName("HKPassengerFlowAnalysis") \
        .config("spark.sql.shuffle.partitions", "4") \
        .getOrCreate()
    spark.sparkContext.setLogLevel("WARN")


    # ── Load IMMD CSV ──────────────────────────────────────────────────────
    print("[INFO] Downloading IMMD passenger CSV...")
    csv_text = fetch_immd_text()

    # Strip BOM if present before writing
    with open("/tmp/immd_passenger.csv", "w", encoding="utf-8") as f:
        f.write(csv_text.lstrip("\ufeff"))
    df = spark.read \
        .option("header", True) \
        .option("inferSchema", False) \
        .option("encoding", "UTF-8") \
        .csv("/tmp/immd_passenger.csv")

    # Actual column names from CSV:
    # "Date", "Control Point", "Arrival / Departure",
    # "Hong Kong Residents", "Mainland Visitors", "Other Visitors", "Total"
    # Rename by position to handle BOM in first column name
    old_cols = df.columns
    df = df.toDF("date_str", "control_point", "direction",
                 "hk_residents", "mainland_visitors", "other_visitors", "total", "_c7")

    # Parse date: format is "01-01-2021" → DD-MM-YYYY
    df = df.withColumn("date", to_date(col("date_str"), "dd-MM-yyyy")) \
           .filter(col("date").isNotNull()) \
           .filter(col("date") >= "2021-01-01")

    # Cast numeric columns
    for c in ["hk_residents", "mainland_visitors", "other_visitors", "total"]:
        df = df.withColumn(c, col(c).cast("integer"))

    df = df.withColumn("dow", dayofweek(col("date")))

    print(f"[INFO] Loaded {df.count()} passenger records")

    # ── Collect and enrich with holiday data in Python ─────────────────────
    print("[INFO] Collecting records and classifying day types...")
    collected = df.select(
        col("date"), col("control_point"), col("direction"),
        col("hk_residents"), col("mainland_visitors"),
        col("other_visitors"), col("total"), col("dow"),
    ).collect()

    def classify(date_val, dow):
        d = date_val.isoformat() if date_val else None
        if not d:
            return False, None, "Unknown"
        if d in lunar_dates:
            return True, "Lunar New Year", "Lunar New Year"
        if d in holidays:
            return True, holiday_names.get(d, "Public Holiday"), "Public Holiday"
        if dow in (1, 7):
            return False, None, "Weekend"
        return False, None, "Weekday"

    batch = []
    for row in collected:
        if row["total"] is None:
            continue
        is_ph, hname, day_type = classify(row["date"], row["dow"])
        batch.append((
            row["date"], row["control_point"], row["direction"],
            row["hk_residents"], row["mainland_visitors"],
            row["other_visitors"], row["total"],
            is_ph, hname, day_type,
        ))

    conn = psycopg2.connect(**DB)
    conn.autocommit = False
    with conn.cursor() as cur:
        cur.execute("TRUNCATE TABLE passenger_daily_summary")
    conn.commit()

    with conn.cursor() as cur:
        execute_values(cur, """
            INSERT INTO passenger_daily_summary
                (date, control_point, direction, hk_residents, mainland_visitors,
                 other_visitors, total, is_public_holiday, holiday_name, day_type)
            VALUES %s
        """, batch)
    conn.commit()
    conn.close()
    print(f"[INFO] Inserted {len(batch)} rows into passenger_daily_summary")

    # ── Spark aggregations (MapReduce demonstration) ───────────────────────
    print("\n[INFO] === Top 5 control points by total volume ===")
    df.groupBy("control_point") \
      .agg(spark_sum("total").alias("total_volume")) \
      .orderBy("total_volume", ascending=False) \
      .show(5, truncate=False)

    spark.stop()
    print("[INFO] Passenger flow analysis job complete")


if __name__ == "__main__":
    main()
