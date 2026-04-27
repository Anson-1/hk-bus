"""
Spark batch job: HK Traffic Accident Analysis
Reads 4 government CSV tables (2024 + multi-year trend),
unpivots them with Spark, writes unified results to accident_summary table.

Run:
    python accident_analysis_job.py

Requires:
    pip install pyspark requests psycopg2-binary
"""

import os
import io
import sys
import requests
import psycopg2
from psycopg2.extras import execute_values
from pyspark.sql import SparkSession
from pyspark.sql.functions import col, lit, when, regexp_replace, trim
from pyspark.sql.types import IntegerType

# ── Config ──────────────────────────────────────────────────────────────────
DB = {
    "host": os.getenv("POSTGRES_HOST", "localhost"),
    "port": int(os.getenv("POSTGRES_PORT", 5432)),
    "dbname": os.getenv("POSTGRES_DB", "hk_bus"),
    "user": os.getenv("POSTGRES_USER", "postgres"),
    "password": os.getenv("POSTGRES_PASSWORD", "postgres"),
}

BASE_URL_2024 = "https://www.td.gov.hk/datagovhk_td/rt-accidentstat-2024/resources/{}"
BASE_URL_2023 = "https://www.td.gov.hk/datagovhk_td/rt-accidentstat-2023/resources/{}"

DAY_MAP = {
    "Monday": 2, "Tuesday": 3, "Wednesday": 4,
    "Thursday": 5, "Friday": 6, "Saturday": 7, "Sunday": 1,
}

# ── Helpers ──────────────────────────────────────────────────────────────────
def fetch_csv_text(url: str) -> str:
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    return r.text


def csv_text_to_spark(spark, text: str, tmp_path: str):
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write(text)
    return spark.read.option("header", True).option("inferSchema", True).csv(tmp_path)


def write_to_db(rows: list[tuple], conn):
    if not rows:
        print("[WARN] No rows to insert")
        return
    with conn.cursor() as cur:
        execute_values(cur, """
            INSERT INTO accident_summary
                (year, hour_of_day, day_of_week, district, accident_type,
                 road_condition, severity, count)
            VALUES %s
        """, rows)
    conn.commit()
    print(f"[INFO] Inserted {len(rows)} rows")


# ── Job 1: By hour × day-of-week  (f2.5) ────────────────────────────────────
def process_hourly(spark, year: int) -> list[tuple]:
    """
    CSV shape (BOM-prefixed):
      "Hour of the day" | "Item" | Monday | Tuesday | ... | Sunday | All Days
    Item values are "Number" (counts) and "Average" — keep "Number" rows only.
    """
    base = BASE_URL_2024 if year == 2024 else BASE_URL_2023
    text = fetch_csv_text(base.format("f2.5_eng.csv"))
    # Strip BOM before writing to temp file
    text = text.lstrip("\ufeff")
    df = csv_text_to_spark(spark, text, "/tmp/acc_f25.csv")

    # Find columns by partial name match (BOM may mangle first col name)
    item_col = [c for c in df.columns if "Item" in c][0]
    hour_col = [c for c in df.columns if "Hour" in c or "hour" in c.lower()][0]

    # CSV uses "Number" for counts (not "Number of accidents")
    df = df.filter(col(item_col) == "Number") \
           .filter(~col(hour_col).isin(["Total", "All"]))

    rows = []
    for row in df.collect():
        hour_str = str(row[hour_col]).strip()  # e.g. "0800-0859"
        if not hour_str or not hour_str[0].isdigit():
            continue
        try:
            hour_of_day = int(hour_str[:2])
        except ValueError:
            continue
        for day_name, dow in DAY_MAP.items():
            try:
                count = int(row[day_name])
            except (TypeError, ValueError, KeyError):
                continue
            rows.append((year, hour_of_day, dow, None, None, None, "All", count))
    return rows


# ── Job 2: By district × severity  (f2.6) ────────────────────────────────────
def process_district(spark, year: int) -> list[tuple]:
    """
    CSV shape:
      "District Council district" | "Severity: Fatal" | "Severity: Serious" | "Severity: Slight" | "Severity: All"
    We want: year, district, severity, count
    Skip subtotal rows ending in ": All".
    """
    base = BASE_URL_2024 if year == 2024 else BASE_URL_2023
    text = fetch_csv_text(base.format("f2.6_eng.csv"))
    df = csv_text_to_spark(spark, text, "/tmp/acc_f26.csv")

    dist_col = df.columns[0]
    severity_cols = {
        "Fatal":   [c for c in df.columns if "Fatal" in c][0],
        "Serious": [c for c in df.columns if "Serious" in c][0],
        "Slight":  [c for c in df.columns if "Slight" in c][0],
    }

    rows = []
    for row in df.collect():
        district = str(row[dist_col]).strip()
        # Skip subtotal rows like "Hong Kong Island: All" or "All"
        if district.endswith(": All") or district == "All":
            continue
        for severity, col_name in severity_cols.items():
            try:
                count = int(row[col_name])
            except (TypeError, ValueError):
                continue
            rows.append((year, None, None, district, None, None, severity, count))
    return rows


# ── Job 3: By collision type × road condition  (f2.7) ────────────────────────
def process_road_condition(spark, year: int) -> list[tuple]:
    """
    CSV shape:
      "Type of accident collision" | "Severity" | "Road surface condition: Wet" | "...Dry" | "...Unknown" | "...All"
    We want: year, accident_type, road_condition, severity, count
    Skip "All types" summary rows.
    """
    base = BASE_URL_2024 if year == 2024 else BASE_URL_2023
    text = fetch_csv_text(base.format("f2.7_eng.csv"))
    df = csv_text_to_spark(spark, text, "/tmp/acc_f27.csv")

    type_col = df.columns[0]
    sev_col  = df.columns[1]
    cond_cols = {
        "Wet":     [c for c in df.columns if "Wet" in c][0],
        "Dry":     [c for c in df.columns if "Dry" in c][0],
        "Unknown": [c for c in df.columns if "Unknown" in c][0],
    }

    rows = []
    for row in df.collect():
        acc_type = str(row[type_col]).strip()
        severity = str(row[sev_col]).strip()
        if acc_type == "All types" or severity == "All":
            continue
        for condition, col_name in cond_cols.items():
            try:
                count = int(row[col_name])
            except (TypeError, ValueError):
                continue
            rows.append((year, None, None, None, acc_type, condition, severity, count))
    return rows


# ── Job 4: Multi-year trend  (f2.2) ──────────────────────────────────────────
def process_yearly_trend(spark) -> list[tuple]:
    """
    CSV shape:
      "Type of accident collision" | "Severity" | "2014" | "2015" | ... | "2024"
    We want: year, accident_type, severity, count  (for 2021-2024 only)
    Skip "All types" and severity=="All" rows.
    """
    text = fetch_csv_text(BASE_URL_2024.format("f2.2_eng.csv"))
    df = csv_text_to_spark(spark, text, "/tmp/acc_f22.csv")

    type_col = df.columns[0]
    sev_col  = df.columns[1]
    year_cols = [c for c in df.columns if c.strip().isdigit() and int(c.strip()) >= 2021]

    rows = []
    for row in df.collect():
        acc_type = str(row[type_col]).strip()
        severity = str(row[sev_col]).strip()
        if acc_type == "All types" or severity == "All":
            continue
        for yr_col in year_cols:
            try:
                count = int(row[yr_col])
                year  = int(yr_col.strip())
            except (TypeError, ValueError):
                continue
            rows.append((year, None, None, None, acc_type, None, severity, count))
    return rows


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    print("[INFO] Starting Accident Analysis Spark Job")
    spark = SparkSession.builder \
        .appName("HKAccidentAnalysis") \
        .config("spark.sql.shuffle.partitions", "4") \
        .getOrCreate()
    spark.sparkContext.setLogLevel("WARN")

    conn = psycopg2.connect(**DB)
    conn.autocommit = False

    # Clear existing data
    with conn.cursor() as cur:
        cur.execute("TRUNCATE TABLE accident_summary")
    conn.commit()

    all_rows = []

    print("[INFO] Processing hourly distribution (f2.5)...")
    all_rows += process_hourly(spark, 2024)

    print("[INFO] Processing district breakdown (f2.6)...")
    all_rows += process_district(spark, 2024)

    print("[INFO] Processing road condition × collision type (f2.7)...")
    all_rows += process_road_condition(spark, 2024)

    print("[INFO] Processing multi-year trend 2021-2024 (f2.2)...")
    all_rows += process_yearly_trend(spark)

    print(f"[INFO] Total rows to write: {len(all_rows)}")
    write_to_db(all_rows, conn)

    conn.close()
    spark.stop()
    print("[INFO] Accident analysis job complete")


if __name__ == "__main__":
    main()
