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
