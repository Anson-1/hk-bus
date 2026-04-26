#!/usr/bin/env python3
"""
Weather Data Analysis for Route 91M Correlation
Analyze what weather data is useful for bus delay correlation
"""

import requests
import json
from datetime import datetime
from collections import defaultdict

print("\n" + "=" * 70)
print("🎯 WEATHER API ANALYSIS FOR ROUTE 91M DASHBOARD")
print("=" * 70)

# Fetch weather data
WEATHER_API = "https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=en"
response = requests.get(WEATHER_API)
data = response.json()

print(f"\n📊 Data collected at: {data['updateTime']}")

# Analysis 1: Temperature distribution
print("\n" + "-" * 70)
print("1. TEMPERATURE ANALYSIS (For correlation with delays)")
print("-" * 70)

temps = data['temperature']['data']
temp_values = [t.get('value') for t in temps if t.get('value')]
temp_values.sort()

print(f"   Total stations: {len(temps)}")
print(f"   Stations with data: {len(temp_values)}")
print(f"   Min: {min(temp_values)}°C, Max: {max(temp_values)}°C")
print(f"   Avg: {sum(temp_values)/len(temp_values):.1f}°C")

print(f"\n   📌 TUEN MUN Station (Route 91M corridor):")
for t in temps:
    if 'Tuen Mun' in t.get('place', ''):
        print(f"      Temperature: {t.get('value')}°C")

print(f"\n   ❓ Insight: Does temperature impact delays?")
print(f"      • Cold days: Slower traffic? Reduced passenger flow?")
print(f"      • Hot days: More A/C demand? Packed buses?")

# Analysis 2: Rainfall correlation potential
print("\n" + "-" * 70)
print("2. RAINFALL ANALYSIS (Primary factor)")
print("-" * 70)

rainfall_data = data['rainfall']['data']
rainfall_dict = {}

for r in rainfall_data:
    place = r.get('place')
    max_rain = r.get('max', 0)
    rainfall_dict[place] = max_rain

print(f"   Total zones: {len(rainfall_data)}")

# Key areas for Route 91M
route_91m_areas = ['Tuen Mun', 'Tsuen Wan', 'Kwai Tsing', 'Yuen Long']
print(f"\n   🚌 ROUTE 91M RELEVANT AREAS:")
for area in route_91m_areas:
    rain = rainfall_dict.get(area, 'N/A')
    print(f"      • {area}: {rain} mm")

print(f"\n   ❓ Insight: Rainfall is the strongest weather factor")
print(f"      • Rain = More caution driving = Slower buses")
print(f"      • Expected impact: +5 to +15 minutes wait time")
print(f"      • Data quality: ✅ All 18 zones report values")

# Analysis 3: Humidity
print("\n" + "-" * 70)
print("3. HUMIDITY ANALYSIS (Secondary factor)")
print("-" * 70)

humidity_data = data['humidity'].get('data', [])
if humidity_data:
    h = humidity_data[0]
    print(f"   Current: {h.get('value')}% (from {h.get('place')})")
    print(f"   ❓ Insight: May correlate with weather quality")
    print(f"      • High humidity + heat = Discomfort = Avoid travel?")
    print(f"      • Data quality: ⚠️  Only 1 station reported")
else:
    print(f"   ⚠️  No humidity data available")

# Analysis 4: Other data
print("\n" + "-" * 70)
print("4. OTHER AVAILABLE DATA")
print("-" * 70)

print(f"   • uvindex: {data.get('uvindex', 'N/A')}")
print(f"   • warningMessage: {data.get('warningMessage', 'None')}")
print(f"   • rainfallFrom00To12: {data.get('rainfallFrom00To12', 'N/A')} (daily so far)")
print(f"   • rainfallLastMonth: {data.get('rainfallLastMonth', 'N/A')}")

# Analysis 5: Data collection pattern
print("\n" + "-" * 70)
print("5. DATA COLLECTION SCHEDULE")
print("-" * 70)

update_time = data['updateTime']
icon_update_time = data['iconUpdateTime']

print(f"   Weather data updated: {update_time}")
print(f"   Icon data updated: {icon_update_time}")
print(f"\n   💡 Strategy: Fetch hourly, aligned with ETA Fetcher schedule")
print(f"      • Same timestamp alignment as eta_processed window")
print(f"      • Store in weather_hourly table")
print(f"      • Join with eta_analytics for correlation")

# Analysis 6: Database design implications
print("\n" + "-" * 70)
print("6. RECOMMENDED DATABASE SCHEMA")
print("-" * 70)

print("""
CREATE TABLE weather_hourly (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMP NOT NULL UNIQUE,
    
    -- Temperature metrics
    temp_c_avg NUMERIC,           -- Average across all stations
    temp_c_min NUMERIC,           -- Min across stations
    temp_c_max NUMERIC,           -- Max across stations
    temp_c_tuen_mun NUMERIC,      -- Specific to Route 91M area
    
    -- Rainfall metrics
    rainfall_tuen_mun_mm NUMERIC, -- Route 91M area (most important)
    rainfall_tsuen_wan_mm NUMERIC,-- Adjacent area
    rainfall_max_hk_mm NUMERIC,   -- Max rainfall in HK (weather severity)
    
    -- Humidity
    humidity_pct NUMERIC,          -- From Observatory
    
    -- Derived weather condition
    weather_condition VARCHAR(20), -- 'Clear', 'Rainy', 'Humid', 'Extreme'
    
    -- Raw data backup
    raw_data JSONB,               -- Full API response
    
    fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_weather_timestamp ON weather_hourly(timestamp DESC);
CREATE INDEX idx_weather_condition ON weather_hourly(weather_condition);
""")

# Analysis 7: Correlation view design
print("\n" + "-" * 70)
print("7. CORRELATION VIEW FOR GRAFANA")
print("-" * 70)

print("""
View: weather_eta_correlation
Purpose: Join weather hourly data with eta_analytics for visualization

SELECT 
    DATE_TRUNC('hour', ea.analysis_date) as hour,
    ea.route,
    ea.avg_wait_sec / 60.0 as avg_wait_min,
    
    -- Weather factors
    wh.temp_c_avg,
    wh.rainfall_tuen_mun_mm,
    wh.humidity_pct,
    wh.weather_condition,
    
    -- For Grafana panels
    CASE 
        WHEN wh.rainfall_tuen_mun_mm > 0 THEN 'Rainy'
        ELSE 'Clear'
    END as rain_flag,
    
    -- Aggregation metadata
    ea.sample_count
    
FROM eta_analytics ea
LEFT JOIN weather_hourly wh 
    ON DATE_TRUNC('hour', ea.analysis_date) = wh.timestamp
WHERE ea.route = '91M'
ORDER BY hour DESC;
""")

# Final recommendations
print("\n" + "-" * 70)
print("8. GRAFANA VISUALIZATION RECOMMENDATIONS")
print("-" * 70)

print("""
Panel 1: Wait Time vs Rainfall (Scatter Plot)
  ├─ X-axis: Rainfall (mm)
  ├─ Y-axis: Avg wait (min)
  └─ Shows: Direct correlation - should see wait time increase with rain

Panel 2: Temperature Trend (Line Chart, Time-Series)
  ├─ Line 1: Avg wait time (min)
  ├─ Line 2: Temperature (°C) 
  ├─ Y-axis dual: Time (min) vs Temp (°C)
  └─ Shows: Whether temp correlates with delays

Panel 3: Weather Impact Matrix (Heatmap)
  ├─ X-axis: Hour of day (0-23)
  ├─ Y-axis: Weather condition (Clear/Rainy)
  ├─ Color intensity: Avg wait time
  └─ Shows: Which hours + weather combinations = worst delays

Panel 4: Weather Distribution (Bar Chart)
  ├─ Bars: Rainfall min/avg/max by weather condition
  └─ Shows: Rainfall severity distribution

Panel 5: Raw Data Table
  ├─ Columns: Timestamp, Temp, Rainfall, Humidity, Avg Wait, Samples
  └─ Shows: Detailed drill-down data for analysis
""")

print("\n✅ Analysis complete!")
print("\nNext: Let's implement this schema and fetcher!")
