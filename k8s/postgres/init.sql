CREATE DATABASE hkbus;
\c hkbus;

-- Raw archive — every ETA record ingested
CREATE TABLE IF NOT EXISTS eta_raw (
    id             SERIAL PRIMARY KEY,
    co             VARCHAR(10),
    route          VARCHAR(10)   NOT NULL,
    dir            CHAR(1)       NOT NULL,
    stop           VARCHAR(64)   NOT NULL,
    eta_seq        INT,
    eta            TIMESTAMPTZ,
    rmk_en         TEXT,
    data_timestamp TIMESTAMPTZ,
    fetched_at     TIMESTAMPTZ   NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eta_raw_route ON eta_raw (route, dir);
CREATE INDEX IF NOT EXISTS idx_eta_raw_fetched ON eta_raw (fetched_at);

-- Spark Streaming output — 1-minute window aggregates
CREATE TABLE IF NOT EXISTS eta_realtime (
    route         VARCHAR(10)   NOT NULL,
    dir           CHAR(1)       NOT NULL,
    window_start  TIMESTAMPTZ   NOT NULL,
    avg_wait_sec  FLOAT,
    delay_flag    BOOLEAN,
    sample_count  INT,
    PRIMARY KEY (route, dir, window_start)
);

-- Spark Batch output — hourly historical analytics
CREATE TABLE IF NOT EXISTS eta_analytics (
    route         VARCHAR(10)   NOT NULL,
    hour_of_day   INT           NOT NULL,  -- 0-23
    day_of_week   INT           NOT NULL,  -- 0=Monday, 6=Sunday
    avg_wait_sec  FLOAT,
    p95_wait_sec  FLOAT,
    computed_at   TIMESTAMPTZ   NOT NULL,
    PRIMARY KEY (route, hour_of_day, day_of_week, computed_at)
);
