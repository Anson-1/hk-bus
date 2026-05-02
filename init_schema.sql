-- ============================================================
-- HK Transit Database Schema
-- 4 separate schemas: kmb, ctb, gmb, mtr
-- ============================================================

-- ── Create schemas ───────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS kmb;
CREATE SCHEMA IF NOT EXISTS ctb;
CREATE SCHEMA IF NOT EXISTS gmb;
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
-- CTB
-- ============================================================

CREATE TABLE IF NOT EXISTS ctb.stops (
    stop_id   VARCHAR(64) PRIMARY KEY,
    name_en   TEXT,
    name_tc   TEXT,
    lat       DOUBLE PRECISION,
    lng       DOUBLE PRECISION
);

CREATE TABLE IF NOT EXISTS ctb.routes (
    route     VARCHAR(20)  NOT NULL,
    bound     CHAR(1)      NOT NULL,
    orig_en   TEXT,
    dest_en   TEXT,
    orig_tc   TEXT,
    dest_tc   TEXT,
    PRIMARY KEY (route, bound)
);

CREATE TABLE IF NOT EXISTS ctb.eta (
    id            BIGSERIAL    PRIMARY KEY,
    route         VARCHAR(20)  NOT NULL,
    dir           CHAR(1)      NOT NULL,
    stop_id       VARCHAR(64)  NOT NULL,
    eta_seq       SMALLINT     NOT NULL,
    wait_minutes  SMALLINT,
    eta_timestamp TIMESTAMP,
    is_scheduled  BOOLEAN,
    remarks       TEXT,
    fetched_at    TIMESTAMP  NOT NULL DEFAULT NOW(),
    hour_of_day   SMALLINT     NOT NULL,
    day_of_week   SMALLINT     NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ctb_eta_route   ON ctb.eta (route, dir);
CREATE INDEX IF NOT EXISTS idx_ctb_eta_fetched ON ctb.eta (fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_ctb_eta_hour    ON ctb.eta (hour_of_day, day_of_week);
CREATE INDEX IF NOT EXISTS idx_ctb_eta_delay   ON ctb.eta (is_scheduled, fetched_at DESC);

-- ============================================================
-- GMB
-- ============================================================

CREATE TABLE IF NOT EXISTS gmb.stops (
    stop_id   BIGINT  PRIMARY KEY,  -- GMB stop IDs are integers
    name_en   TEXT,
    name_tc   TEXT,
    region    VARCHAR(10)           -- HKI / KLN / NT
);

CREATE TABLE IF NOT EXISTS gmb.routes (
    route_id   INTEGER      NOT NULL,
    route_seq  SMALLINT     NOT NULL,  -- 1=outbound, 2=inbound
    route_code VARCHAR(20),
    region     VARCHAR(10),
    orig_en    TEXT,
    dest_en    TEXT,
    PRIMARY KEY (route_id, route_seq)
);

CREATE TABLE IF NOT EXISTS gmb.headways (
    route_id    INTEGER   NOT NULL,
    route_seq   SMALLINT  NOT NULL,
    start_time  TIME      NOT NULL,
    end_time    TIME      NOT NULL,
    frequency   SMALLINT,            -- scheduled minutes between buses
    is_weekday  BOOLEAN,
    is_holiday  BOOLEAN,
    PRIMARY KEY (route_id, route_seq, start_time, is_weekday, is_holiday)
);

CREATE TABLE IF NOT EXISTS gmb.eta (
    id            BIGSERIAL    PRIMARY KEY,
    route_id      INTEGER      NOT NULL,
    route_code    VARCHAR(20),
    region        VARCHAR(10),
    route_seq     SMALLINT     NOT NULL,
    stop_id       BIGINT       NOT NULL,
    eta_seq       SMALLINT     NOT NULL,
    wait_minutes  SMALLINT,
    eta_timestamp TIMESTAMP,
    is_scheduled  BOOLEAN,
    remarks       TEXT,
    fetched_at    TIMESTAMP  NOT NULL DEFAULT NOW(),
    hour_of_day   SMALLINT     NOT NULL,
    day_of_week   SMALLINT     NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gmb_eta_route   ON gmb.eta (route_id, route_seq);
CREATE INDEX IF NOT EXISTS idx_gmb_eta_fetched ON gmb.eta (fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_gmb_eta_hour    ON gmb.eta (hour_of_day, day_of_week);
CREATE INDEX IF NOT EXISTS idx_gmb_eta_delay   ON gmb.eta (is_scheduled, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_gmb_eta_region  ON gmb.eta (region, fetched_at DESC);

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
