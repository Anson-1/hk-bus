-- ============================================================
-- HK Transit Reliability Analysis Schema
-- Goal: delay/reliability patterns over time across KMB, CTB, GMB, MTR
-- ============================================================

-- ── Stop reference (populated once, reused) ─────────────────
-- Stores stop metadata so we don't re-fetch names on every poll
CREATE TABLE IF NOT EXISTS stops (
    stop_id     VARCHAR(64) PRIMARY KEY,   -- KMB/CTB: string ID, GMB: integer as string, MTR: station code
    co          VARCHAR(10) NOT NULL,      -- KMB / CTB / GMB / MTR
    name_en     TEXT,
    name_tc     TEXT,
    lat         DOUBLE PRECISION,
    lng         DOUBLE PRECISION,
    region      VARCHAR(10)                -- GMB only: HKI / KLN / NT
);

-- ── GMB headway reference (scheduled frequency, stored once) ─
-- Used to compare actual wait time vs scheduled headway
CREATE TABLE IF NOT EXISTS gmb_headways (
    route_id    INTEGER      NOT NULL,
    route_seq   INTEGER      NOT NULL,
    route_code  VARCHAR(20),
    region      VARCHAR(10),
    start_time  TIME         NOT NULL,
    end_time    TIME         NOT NULL,
    frequency   INTEGER,                   -- scheduled minutes between buses
    is_weekday  BOOLEAN,
    is_holiday  BOOLEAN,
    PRIMARY KEY (route_id, route_seq, start_time, is_weekday, is_holiday)
);

-- ── Main ETA collection table ────────────────────────────────
-- One row per ETA entry per poll cycle
-- For KMB/CTB: up to 3 rows per stop (eta_seq 1/2/3)
-- For GMB:     up to 3 rows per stop (eta_seq 1/2/3)
-- For MTR:     2-4 rows per station per direction
CREATE TABLE IF NOT EXISTS eta_records (
    id              BIGSERIAL PRIMARY KEY,
    co              VARCHAR(10)  NOT NULL,  -- KMB / CTB / GMB / MTR
    route           VARCHAR(20)  NOT NULL,  -- route number
    region          VARCHAR(10),            -- GMB only: HKI / KLN / NT
    dir             VARCHAR(5)   NOT NULL,  -- O/I (bus) or UP/DOWN (MTR)
    stop_id         VARCHAR(64)  NOT NULL,
    eta_seq         SMALLINT     NOT NULL DEFAULT 1,  -- 1=next bus, 2=2nd, 3=3rd
    wait_minutes    SMALLINT,               -- minutes until arrival at fetch time
    eta_timestamp   TIMESTAMPTZ,            -- absolute arrival time (null for GMB when diff<0)
    is_scheduled    BOOLEAN,                -- TRUE = on schedule, FALSE = delayed/irregular
    remarks         TEXT,                   -- raw rmk_en / remarks_en / source field
    fetched_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    hour_of_day     SMALLINT     NOT NULL,  -- 0-23, pre-computed for fast Grafana GROUP BY
    day_of_week     SMALLINT     NOT NULL   -- 0=Mon ... 6=Sun
);

-- Indexes for the queries Grafana will run
CREATE INDEX IF NOT EXISTS idx_eta_co_route       ON eta_records (co, route);
CREATE INDEX IF NOT EXISTS idx_eta_fetched        ON eta_records (fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_eta_hour_day       ON eta_records (hour_of_day, day_of_week);
CREATE INDEX IF NOT EXISTS idx_eta_reliability    ON eta_records (co, route, is_scheduled, fetched_at);
CREATE INDEX IF NOT EXISTS idx_eta_stop           ON eta_records (stop_id, fetched_at DESC);

-- ── Hourly reliability summary (pre-aggregated) ──────────────
-- Computed every hour from eta_records — makes Grafana dashboards fast
-- without scanning millions of raw rows
CREATE TABLE IF NOT EXISTS reliability_hourly (
    co              VARCHAR(10)  NOT NULL,
    route           VARCHAR(20)  NOT NULL,
    region          VARCHAR(10),
    dir             VARCHAR(5)   NOT NULL,
    hour_of_day     SMALLINT     NOT NULL,
    day_of_week     SMALLINT     NOT NULL,
    window_start    TIMESTAMPTZ  NOT NULL,
    total_samples   INTEGER      NOT NULL,
    on_time_count   INTEGER      NOT NULL,
    avg_wait_min    FLOAT,
    p50_wait_min    FLOAT,        -- median
    p95_wait_min    FLOAT,        -- 95th percentile (worst case)
    max_wait_min    FLOAT,
    PRIMARY KEY (co, route, dir, window_start)
);

CREATE INDEX IF NOT EXISTS idx_reliability_lookup ON reliability_hourly (co, route, window_start);
CREATE INDEX IF NOT EXISTS idx_reliability_hour   ON reliability_hourly (hour_of_day, day_of_week, co);

-- ── Auto-cleanup: keep only 16 days of raw records ───────────
-- Prevents unbounded growth; reliability_hourly keeps the summaries
-- Run this daily via a scheduled job in the eta-fetcher service
-- DELETE FROM eta_records WHERE fetched_at < NOW() - INTERVAL '16 days';
