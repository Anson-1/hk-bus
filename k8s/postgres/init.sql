CREATE TABLE IF NOT EXISTS stops (
    stop_id  VARCHAR(64) PRIMARY KEY,
    name_en  TEXT,
    name_tc  TEXT
);

CREATE TABLE IF NOT EXISTS delay_alerts (
    id         SERIAL PRIMARY KEY,
    company    VARCHAR(10),
    route      VARCHAR(10) NOT NULL,
    stop_id    VARCHAR(64),
    wait_sec   INT,
    alerted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alerts_route ON delay_alerts (route, alerted_at);

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
CREATE INDEX IF NOT EXISTS idx_eta_raw_route   ON eta_raw (route, dir);
CREATE INDEX IF NOT EXISTS idx_eta_raw_fetched ON eta_raw (fetched_at);

CREATE TABLE IF NOT EXISTS eta_realtime (
    route         VARCHAR(10)   NOT NULL,
    dir           CHAR(1)       NOT NULL,
    stop_id       VARCHAR(64)   NOT NULL,
    window_start  TIMESTAMPTZ   NOT NULL,
    avg_wait_sec  FLOAT,
    sample_count  INT,
    PRIMARY KEY (route, dir, stop_id, window_start)
);
CREATE INDEX IF NOT EXISTS idx_eta_realtime_lookup ON eta_realtime (route, dir, stop_id);

CREATE TABLE IF NOT EXISTS eta_analytics (
    route         VARCHAR(10)   NOT NULL,
    hour_of_day   INT           NOT NULL,
    day_of_week   INT           NOT NULL,
    avg_wait_sec  FLOAT,
    p95_wait_sec  FLOAT,
    computed_at   TIMESTAMPTZ   NOT NULL,
    PRIMARY KEY (route, hour_of_day, day_of_week, computed_at)
);

-- ── Accident data (loaded daily by accident-fetcher OpenFaaS function) ─────────
CREATE TABLE IF NOT EXISTS accident_summary (
    id             SERIAL PRIMARY KEY,
    year           INTEGER,
    hour_of_day    INTEGER,
    day_of_week    INTEGER,
    district       VARCHAR(100),
    accident_type  VARCHAR(100),
    road_condition VARCHAR(50),
    severity       VARCHAR(50),
    count          INTEGER,
    computed_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_accident_year     ON accident_summary(year);
CREATE INDEX IF NOT EXISTS idx_accident_district ON accident_summary(district);

-- ── Passenger flow data (loaded daily by passenger-fetcher OpenFaaS function) ──
CREATE TABLE IF NOT EXISTS passenger_daily_summary (
    id                 SERIAL PRIMARY KEY,
    date               DATE NOT NULL,
    control_point      VARCHAR(100),
    direction          VARCHAR(20),
    hk_residents       INTEGER,
    mainland_visitors  INTEGER,
    other_visitors     INTEGER,
    total              INTEGER,
    is_public_holiday  BOOLEAN DEFAULT FALSE,
    holiday_name       VARCHAR(100),
    day_type           VARCHAR(30),
    computed_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_passenger_date     ON passenger_daily_summary(date DESC);
CREATE INDEX IF NOT EXISTS idx_passenger_point    ON passenger_daily_summary(control_point);
CREATE INDEX IF NOT EXISTS idx_passenger_day_type ON passenger_daily_summary(day_type);

-- ── Real-time traffic (loaded every 2 min by traffic-fetcher OpenFaaS function) ─
CREATE TABLE IF NOT EXISTS traffic_detector_locations (
    aid_id    VARCHAR(20) PRIMARY KEY,
    district  VARCHAR(100),
    road_en   VARCHAR(200),
    latitude  NUMERIC(10,6),
    longitude NUMERIC(10,6),
    direction VARCHAR(50)
);

CREATE TABLE IF NOT EXISTS traffic_speed_volume (
    id          SERIAL PRIMARY KEY,
    detector_id VARCHAR(20) NOT NULL,
    direction   VARCHAR(20),
    lane_id     VARCHAR(50),
    speed       INTEGER,
    volume      INTEGER,
    occupancy   NUMERIC(5,2),
    period_from TIME,
    period_to   TIME,
    report_date DATE,
    fetched_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_traffic_detector_fetched ON traffic_speed_volume(detector_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_traffic_fetched          ON traffic_speed_volume(fetched_at DESC);
