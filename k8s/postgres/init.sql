-- Database hk_bus is already created by POSTGRES_DB env var
\c hk_bus;

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

-- Weather data collection (hourly from HK government API)
-- Correlated with Route 91M ETA for delay analysis
CREATE TABLE IF NOT EXISTS weather_hourly (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMP NOT NULL UNIQUE,
    
    -- Temperature metrics (from 27 HK stations)
    temp_c_avg NUMERIC,           -- Average across all stations
    temp_c_min NUMERIC,           -- Coldest location
    temp_c_max NUMERIC,           -- Hottest location
    temp_c_tuen_mun NUMERIC,      -- Route 91M area specifically
    
    -- Rainfall metrics (from 18 HK districts)
    rainfall_tuen_mun_mm NUMERIC, -- ⭐ PRIMARY: Route 91M area
    rainfall_tsuen_wan_mm NUMERIC,-- Adjacent area
    rainfall_max_hk_mm NUMERIC,   -- Maximum rainfall in HK (severity indicator)
    
    -- Humidity from Observatory
    humidity_pct NUMERIC,
    
    -- Derived weather condition for easy filtering
    weather_condition VARCHAR(20), -- 'Clear', 'Rainy', 'Extreme'
    
    -- Raw JSON backup for audit trail
    raw_data JSONB,
    
    fetched_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_weather_timestamp 
    ON weather_hourly(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_weather_condition 
    ON weather_hourly(weather_condition);
CREATE INDEX IF NOT EXISTS idx_weather_fetched 
    ON weather_hourly(fetched_at DESC);

-- Correlation view: Join weather with ETA analytics for Route 91M
-- Used by Grafana for weather-delay correlation visualizations
CREATE OR REPLACE VIEW weather_eta_correlation AS
SELECT 
    DATE_TRUNC('hour', ea.analysis_date)::TIMESTAMP as hour,
    ea.route,
    ea.direction,
    ea.hour_of_day,
    ea.day_of_week,
    
    -- ETA metrics
    ROUND(ea.avg_wait_sec::NUMERIC / 60.0, 2) as avg_wait_min,
    ROUND(ea.min_wait_sec::NUMERIC / 60.0, 2) as min_wait_min,
    ROUND(ea.max_wait_sec::NUMERIC / 60.0, 2) as max_wait_min,
    ROUND(ea.p95_wait_sec::NUMERIC / 60.0, 2) as p95_wait_min,
    ROUND(ea.reliability_pct::NUMERIC, 1) as reliability_pct,
    ea.sample_count,
    
    -- Weather factors
    wh.temp_c_avg,
    wh.temp_c_min,
    wh.temp_c_max,
    wh.temp_c_tuen_mun,
    wh.rainfall_tuen_mun_mm,
    wh.rainfall_max_hk_mm,
    wh.humidity_pct,
    wh.weather_condition,
    
    -- Rainfall flag for easier grouping
    CASE 
        WHEN wh.rainfall_tuen_mun_mm > 0.5 THEN 'Rainy'
        WHEN wh.rainfall_tuen_mun_mm > 0 THEN 'Light Rain'
        ELSE 'Clear'
    END as rainfall_condition,
    
    -- Time fields for analysis
    DATE(ea.analysis_date) as analysis_date
    
FROM eta_analytics ea
LEFT JOIN weather_hourly wh 
    ON DATE_TRUNC('hour', ea.analysis_date) = wh.timestamp
WHERE ea.route = '91M'
ORDER BY hour DESC;

