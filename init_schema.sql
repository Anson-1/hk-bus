-- ============================================================
-- HK Transit Database Schema
-- 2 schemas: kmb, mtr
-- ============================================================

-- ── Create schemas ───────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS kmb;
CREATE SCHEMA IF NOT EXISTS mtr;

-- ============================================================
-- KMB
-- ============================================================

CREATE TABLE IF NOT EXISTS kmb.stops (
    stop_id   VARCHAR(64) PRIMARY KEY,
    name_en   TEXT,
    name_tc   TEXT,
    lat       DOUBLE PRECISION,
    lng       DOUBLE PRECISION
);

CREATE TABLE IF NOT EXISTS kmb.routes (
    route     VARCHAR(20)  NOT NULL,
    bound     CHAR(1)      NOT NULL,  -- O or I
    orig_en   TEXT,
    dest_en   TEXT,
    orig_tc   TEXT,
    dest_tc   TEXT,
    PRIMARY KEY (route, bound)
);

CREATE TABLE IF NOT EXISTS kmb.eta (
    id            BIGSERIAL    PRIMARY KEY,
    route         VARCHAR(20)  NOT NULL,
    dir           CHAR(1)      NOT NULL,  -- O or I
    stop_id       VARCHAR(64)  NOT NULL,
    eta_seq       SMALLINT     NOT NULL,  -- 1=next bus, 2=2nd, 3=3rd
    wait_minutes  SMALLINT,
    eta_timestamp TIMESTAMP,
    is_scheduled  BOOLEAN,               -- false = delayed
    remarks       TEXT,                  -- raw rmk_en from API
    fetched_at    TIMESTAMP  NOT NULL DEFAULT NOW(),
    hour_of_day   SMALLINT     NOT NULL,
    day_of_week   SMALLINT     NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kmb_eta_route   ON kmb.eta (route, dir);
CREATE INDEX IF NOT EXISTS idx_kmb_eta_fetched ON kmb.eta (fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_kmb_eta_hour    ON kmb.eta (hour_of_day, day_of_week);
CREATE INDEX IF NOT EXISTS idx_kmb_eta_delay   ON kmb.eta (is_scheduled, fetched_at DESC);

-- ============================================================
-- MTR
-- ============================================================

CREATE TABLE IF NOT EXISTS mtr.eta (
    id            BIGSERIAL    PRIMARY KEY,
    line          VARCHAR(10)  NOT NULL,  -- e.g. TWL, KTL, AEL
    station       VARCHAR(10)  NOT NULL,  -- e.g. TST, CEN, HOK
    dir           VARCHAR(5)   NOT NULL,  -- UP or DOWN
    eta_seq       SMALLINT     NOT NULL,  -- 1=next train, 2=2nd, 3=3rd
    dest          VARCHAR(10),            -- destination station code
    platform      VARCHAR(5),
    wait_minutes  SMALLINT,
    eta_timestamp TIMESTAMP,
    fetched_at    TIMESTAMP  NOT NULL DEFAULT NOW(),
    hour_of_day   SMALLINT     NOT NULL,
    day_of_week   SMALLINT     NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mtr_eta_line    ON mtr.eta (line, station);
CREATE INDEX IF NOT EXISTS idx_mtr_eta_fetched ON mtr.eta (fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_mtr_eta_hour    ON mtr.eta (hour_of_day, day_of_week);

-- ============================================================
-- Analytics Views
-- ============================================================

-- ── Shared helper: classify remark into delay_type ───────────
-- 'delay'     : bus explicitly flagged as running late
-- 'final_bus' : last service of the day (not a reliability issue)
-- 'on_time'   : scheduled or no remark

-- ── KMB ──────────────────────────────────────────────────────

-- Recent delay events (rolling 1-hour window) with names
CREATE OR REPLACE VIEW kmb.v_recent_delays AS
SELECT
  e.route,
  COALESCE(r.orig_en || ' → ' || r.dest_en, e.route) AS route_name,
  e.dir,
  e.stop_id,
  s.name_en                                           AS stop_name,
  e.wait_minutes,
  e.eta_seq,
  e.remarks,
  CASE
    WHEN e.remarks = 'Final Bus'           THEN 'final_bus'
    WHEN e.remarks LIKE 'Delayed journey%' THEN 'delay'
    WHEN e.remarks = 'Moving slowly'       THEN 'delay'
    ELSE 'other'
  END                                                 AS delay_type,
  e.fetched_at,
  e.hour_of_day,
  e.day_of_week
FROM kmb.eta e
LEFT JOIN kmb.routes r ON r.route = e.route AND r.bound = e.dir
LEFT JOIN kmb.stops  s ON s.stop_id = e.stop_id
WHERE e.is_scheduled = false
  AND e.fetched_at > NOW() - INTERVAL '1 hour'
ORDER BY e.fetched_at DESC;

-- Routes ranked by true delay % (Final Bus excluded — not a reliability issue)
-- Requires at least 20 next-bus samples for statistical significance
CREATE OR REPLACE VIEW kmb.v_worst_routes AS
SELECT
  e.route,
  COALESCE(r.orig_en || ' → ' || r.dest_en, e.route) AS route_name,
  e.dir,
  COUNT(*)                                            AS total_samples,
  SUM(CASE WHEN e.remarks LIKE 'Delayed journey%'
            OR e.remarks = 'Moving slowly'
           THEN 1 ELSE 0 END)                         AS true_delay_count,
  SUM(CASE WHEN e.remarks = 'Final Bus'
           THEN 1 ELSE 0 END)                         AS final_bus_count,
  ROUND(
    100.0 * SUM(CASE WHEN e.remarks LIKE 'Delayed journey%'
                      OR e.remarks = 'Moving slowly'
                     THEN 1 ELSE 0 END)
    / NULLIF(COUNT(*), 0), 1)                         AS delay_pct,
  ROUND(AVG(e.wait_minutes)::numeric, 1)              AS avg_wait_min,
  ROUND(PERCENTILE_CONT(0.95)
        WITHIN GROUP (ORDER BY e.wait_minutes)::numeric, 1) AS p95_wait_min
FROM kmb.eta e
LEFT JOIN kmb.routes r ON r.route = e.route AND r.bound = e.dir
WHERE e.eta_seq = 1
  AND e.wait_minutes IS NOT NULL
GROUP BY e.route, e.dir, r.orig_en, r.dest_en
HAVING COUNT(*) >= 20
ORDER BY delay_pct DESC;

-- Delay frequency by hour-of-day across all routes
CREATE OR REPLACE VIEW kmb.v_delay_by_hour AS
SELECT
  hour_of_day,
  day_of_week,
  COUNT(*)                                            AS total_samples,
  SUM(CASE WHEN remarks LIKE 'Delayed journey%'
            OR remarks = 'Moving slowly'
           THEN 1 ELSE 0 END)                         AS delay_count,
  SUM(CASE WHEN remarks = 'Final Bus'
           THEN 1 ELSE 0 END)                         AS final_bus_count,
  ROUND(
    100.0 * SUM(CASE WHEN remarks LIKE 'Delayed journey%'
                      OR remarks = 'Moving slowly'
                     THEN 1 ELSE 0 END)
    / NULLIF(COUNT(*), 0), 1)                         AS delay_pct,
  ROUND(AVG(wait_minutes)::numeric, 1)                AS avg_wait_min
FROM kmb.eta
WHERE eta_seq = 1
  AND wait_minutes IS NOT NULL
GROUP BY hour_of_day, day_of_week
ORDER BY hour_of_day, day_of_week;

-- Materialized view: per-route reliability aggregated across all collected data
-- Used by Grafana for fast dashboard queries — refresh hourly via eta-fetcher
CREATE MATERIALIZED VIEW IF NOT EXISTS kmb.mv_route_reliability AS
SELECT
  route,
  dir,
  hour_of_day,
  day_of_week,
  COUNT(*)                                            AS sample_count,
  ROUND(AVG(wait_minutes)::numeric, 1)                AS avg_wait_min,
  ROUND(PERCENTILE_CONT(0.5)
        WITHIN GROUP (ORDER BY wait_minutes)::numeric, 1) AS p50_wait_min,
  ROUND(PERCENTILE_CONT(0.95)
        WITHIN GROUP (ORDER BY wait_minutes)::numeric, 1) AS p95_wait_min,
  ROUND(
    100.0 * SUM(CASE WHEN remarks LIKE 'Delayed journey%'
                      OR remarks = 'Moving slowly'
                     THEN 1 ELSE 0 END)
    / NULLIF(COUNT(*), 0), 1)                         AS delay_pct
FROM kmb.eta
WHERE eta_seq = 1
  AND wait_minutes IS NOT NULL
GROUP BY route, dir, hour_of_day, day_of_week
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_route_reliability
  ON kmb.mv_route_reliability (route, dir, hour_of_day, day_of_week);

-- ── MTR ──────────────────────────────────────────────────────

-- Per-line/station hourly wait stats
CREATE OR REPLACE VIEW mtr.v_station_hourly AS
SELECT
  line,
  station,
  dir,
  hour_of_day,
  day_of_week,
  COUNT(*)                                            AS sample_count,
  ROUND(AVG(wait_minutes)::numeric, 1)                AS avg_wait_min,
  ROUND(PERCENTILE_CONT(0.5)
        WITHIN GROUP (ORDER BY wait_minutes)::numeric, 1) AS p50_wait_min,
  ROUND(PERCENTILE_CONT(0.95)
        WITHIN GROUP (ORDER BY wait_minutes)::numeric, 1) AS p95_wait_min,
  MAX(wait_minutes)                                   AS max_wait_min
FROM mtr.eta
WHERE eta_seq = 1
  AND wait_minutes IS NOT NULL
GROUP BY line, station, dir, hour_of_day, day_of_week;
