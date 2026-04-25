CREATE DATABASE hkbus;
\c hkbus;

-- Raw ETA data from eta-fetcher
CREATE TABLE IF NOT EXISTS eta_raw (
    id         SERIAL PRIMARY KEY,
    route      VARCHAR(10) NOT NULL,
    dir        CHAR(1) NOT NULL,
    stop_id    VARCHAR(100) NOT NULL,
    wait_sec   INTEGER,
    delay_flag BOOLEAN DEFAULT FALSE,
    fetched_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_eta_raw_route_dir_stop 
    ON eta_raw(route, dir, stop_id);
CREATE INDEX IF NOT EXISTS idx_eta_raw_stop_id_fetched 
    ON eta_raw(stop_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_eta_raw_fetched_at 
    ON eta_raw(fetched_at DESC);

-- Spark Streaming output — 5-minute window aggregates
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

-- Spark Batch output — daily analytics
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

-- Historical summary table for quick dashboard queries
CREATE TABLE IF NOT EXISTS eta_summary (
    id SERIAL PRIMARY KEY,
    route VARCHAR(10) NOT NULL,
    direction VARCHAR(1),
    hour_of_day INTEGER,
    day_of_week INTEGER,
    avg_wait_sec NUMERIC,
    reliability_pct NUMERIC,
    most_recent_update TIMESTAMP,
    computed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_summary_route 
    ON eta_summary(route, direction);

