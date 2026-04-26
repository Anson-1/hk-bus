#!/usr/bin/env python3
"""
Generate Grafana dashboard JSON with weather correlation panels
for Route 91M analytics
"""

import json

def create_scatter_panel():
    """Wait Time vs Rainfall scatter plot"""
    return {
        "datasource": "PostgreSQL",
        "fieldConfig": {
            "defaults": {
                "color": {"mode": "palette-classic"},
                "custom": {
                    "hideFrom": {"tooltip": False, "viz": False, "legend": False},
                    "scatterShowLine": False
                },
                "mappings": [],
                "thresholds": {"mode": "absolute", "steps": [{"color": "green", "value": None}]}
            },
            "overrides": []
        },
        "gridPos": {"h": 8, "w": 12, "x": 0, "y": 0},
        "id": 20,
        "options": {
            "legend": {"calcs": [], "displayMode": "list", "placement": "bottom"},
            "tooltip": {"mode": "single", "sort": "none"}
        },
        "pluginVersion": "10.4.0",
        "targets": [
            {
                "format": "table",
                "rawSql": """
SELECT
  rainfall_tuen_mun_mm as rainfall_mm,
  avg_wait_min as wait_time_min,
  weather_condition
FROM weather_eta_correlation
WHERE analysis_date >= now() - interval '30 days'
  AND avg_wait_min IS NOT NULL
  AND rainfall_tuen_mun_mm IS NOT NULL
ORDER BY hour DESC
LIMIT 1000
                """,
                "refId": "A"
            }
        ],
        "title": "📊 Wait Time vs Rainfall Correlation",
        "type": "scatter"
    }

def create_temperature_trend_panel():
    """Temperature and wait time time-series"""
    return {
        "datasource": "PostgreSQL",
        "fieldConfig": {
            "defaults": {
                "color": {"mode": "palette-classic"},
                "custom": {
                    "axisCenteredZero": False,
                    "axisColorMode": "text",
                    "axisLabel": "",
                    "axisPlacement": "auto",
                    "barAlignment": 0,
                    "drawStyle": "line",
                    "fillOpacity": 10,
                    "gradientMode": "none",
                    "hideFrom": {"tooltip": False, "viz": False, "legend": False},
                    "lineInterpolation": "linear",
                    "lineWidth": 1,
                    "pointSize": 5,
                    "scaleDistribution": {"type": "linear"},
                    "showPoints": "auto",
                    "spanNulls": True,
                    "stacking": {"group": "A", "mode": "none"},
                    "thresholdsStyle": {"mode": "off"}
                },
                "mappings": [],
                "thresholds": {"mode": "absolute", "steps": [{"color": "green", "value": None}]},
                "unit": "short"
            },
            "overrides": [
                {
                    "matcher": {"id": "byName", "options": "Temperature (°C)"},
                    "properties": [
                        {
                            "id": "custom.axisPlacement",
                            "value": "right"
                        },
                        {
                            "id": "unit",
                            "value": "celsius"
                        }
                    ]
                }
            ]
        },
        "gridPos": {"h": 8, "w": 12, "x": 12, "y": 0},
        "id": 21,
        "options": {
            "legend": {"calcs": [], "displayMode": "list", "placement": "bottom"},
            "tooltip": {"mode": "multi", "sort": "none"}
        },
        "pluginVersion": "10.4.0",
        "targets": [
            {
                "format": "time_series",
                "rawSql": """
SELECT
  hour as time,
  avg_wait_min as "Wait Time (min)",
  temp_c_avg as "Temperature (°C)"
FROM weather_eta_correlation
WHERE analysis_date >= now() - interval '7 days'
ORDER BY hour DESC
                """,
                "refId": "A",
                "timeColumn": "time"
            }
        ],
        "title": "📈 Temperature & Wait Time Trend",
        "type": "timeseries"
    }

def create_weather_heatmap_panel():
    """Heatmap: Hour of day vs Weather condition"""
    return {
        "datasource": "PostgreSQL",
        "fieldConfig": {
            "defaults": {
                "color": {"mode": "thresholds", "scheme": "RdYlGr-Inverted"},
                "custom": {"hideFrom": {"tooltip": False, "viz": False, "legend": False}},
                "mappings": [],
                "thresholds": {
                    "mode": "absolute",
                    "steps": [
                        {"color": "green", "value": None},
                        {"color": "yellow", "value": 8},
                        {"color": "orange", "value": 12},
                        {"color": "red", "value": 15}
                    ]
                },
                "unit": "min"
            },
            "overrides": []
        },
        "gridPos": {"h": 8, "w": 12, "x": 0, "y": 8},
        "id": 22,
        "options": {
            "calculate": False,
            "cellGap": 2,
            "cellRadius": 2,
            "color": {"scheme": "RdYlGr-Inverted"},
            "exemplars": {"color": "rgba(255,0,255,0.7)"},
            "filterValues": {"le": 1e-9},
            "legend": {"calcs": [], "displayMode": "list", "placement": "bottom"},
            "tooltip": {"show": True, "yHistogram": False}
        },
        "pluginVersion": "10.4.0",
        "targets": [
            {
                "format": "table",
                "rawSql": """
SELECT
  hour_of_day,
  weather_condition,
  ROUND(AVG(avg_wait_min)::numeric, 2) as avg_wait_min
FROM weather_eta_correlation
WHERE analysis_date >= now() - interval '30 days'
  AND avg_wait_min IS NOT NULL
GROUP BY hour_of_day, weather_condition
ORDER BY hour_of_day, weather_condition
                """,
                "refId": "A"
            }
        ],
        "title": "🔥 Weather Impact Heatmap (Hour × Condition)",
        "type": "heatmap"
    }

def create_weather_summary_panel():
    """Bar chart: Weather condition impact"""
    return {
        "datasource": "PostgreSQL",
        "fieldConfig": {
            "defaults": {
                "color": {"mode": "palette-classic"},
                "custom": {
                    "axisLabel": "Wait Time (minutes)",
                    "axisPlacement": "auto",
                    "barAlignment": 0,
                    "drawStyle": "bars",
                    "fillOpacity": 100,
                    "gradientMode": "none",
                    "hideFrom": {"tooltip": False, "viz": False, "legend": False},
                    "lineInterpolation": "linear",
                    "lineWidth": 1,
                    "pointSize": 5,
                    "scaleDistribution": {"type": "linear"},
                    "showPoints": "never",
                    "spanNulls": False,
                    "stacking": {"group": "A", "mode": "none"},
                    "thresholdsStyle": {"mode": "off"}
                },
                "mappings": [],
                "thresholds": {"mode": "absolute", "steps": [{"color": "green", "value": None}]},
                "unit": "min"
            },
            "overrides": []
        },
        "gridPos": {"h": 8, "w": 12, "x": 12, "y": 8},
        "id": 23,
        "options": {
            "legend": {"calcs": ["min", "mean", "max"], "displayMode": "table", "placement": "right"},
            "tooltip": {"mode": "multi"}
        },
        "pluginVersion": "10.4.0",
        "targets": [
            {
                "format": "table",
                "rawSql": """
SELECT
  weather_condition,
  ROUND(MIN(avg_wait_min)::numeric, 2) as min_wait,
  ROUND(AVG(avg_wait_min)::numeric, 2) as avg_wait,
  ROUND(MAX(avg_wait_min)::numeric, 2) as max_wait,
  COUNT(*) as samples
FROM weather_eta_correlation
WHERE analysis_date >= now() - interval '30 days'
  AND avg_wait_min IS NOT NULL
GROUP BY weather_condition
ORDER BY avg_wait DESC
                """,
                "refId": "A"
            }
        ],
        "title": "📊 Weather Impact Summary (Clear/Rainy/Light Rain)",
        "type": "barchart"
    }

def create_data_table_panel():
    """Detailed data table"""
    return {
        "datasource": "PostgreSQL",
        "fieldConfig": {
            "defaults": {
                "color": {"mode": "thresholds"},
                "custom": {
                    "align": "auto",
                    "cellOptions": {"type": "auto"},
                    "inspect": False
                },
                "mappings": [],
                "thresholds": {"mode": "absolute", "steps": [{"color": "green", "value": None}]}
            },
            "overrides": [
                {
                    "matcher": {"id": "byName", "options": "Avg Wait (min)"},
                    "properties": [
                        {"id": "unit", "value": "min"},
                        {
                            "id": "custom.displayMode",
                            "value": "color-background"
                        },
                        {
                            "id": "color",
                            "value": {"mode": "thresholds", "scheme": "RdYlGr-Inverted"}
                        }
                    ]
                },
                {
                    "matcher": {"id": "byName", "options": "Rainfall (mm)"},
                    "properties": [{"id": "unit", "value": "mm"}]
                },
                {
                    "matcher": {"id": "byName", "options": "Temperature (°C)"},
                    "properties": [{"id": "unit", "value": "celsius"}]
                }
            ]
        },
        "gridPos": {"h": 8, "w": 24, "x": 0, "y": 16},
        "id": 24,
        "options": {
            "footer": {"countRows": "all", "fields": "", "reducer": ["sum"], "show": False},
            "showHeader": True,
            "sortBy": [{"displayName": "Hour", "desc": True}]
        },
        "pluginVersion": "10.4.0",
        "targets": [
            {
                "format": "table",
                "rawSql": """
SELECT
  TO_CHAR(hour, 'YYYY-MM-DD HH24:00') as "Hour",
  ROUND(temp_c_avg::numeric, 1) as "Temperature (°C)",
  ROUND(rainfall_tuen_mun_mm::numeric, 2) as "Rainfall (mm)",
  ROUND(humidity_pct::numeric, 0) as "Humidity (%)",
  weather_condition as "Weather",
  ROUND(avg_wait_min::numeric, 2) as "Avg Wait (min)",
  ROUND(p95_wait_min::numeric, 2) as "P95 Wait (min)",
  sample_count as "Samples"
FROM weather_eta_correlation
WHERE analysis_date >= now() - interval '30 days'
ORDER BY hour DESC
LIMIT 500
                """,
                "refId": "A"
            }
        ],
        "title": "📋 Weather & ETA Detailed Data (Last 30 days)",
        "type": "table"
    }

# Create full dashboard
dashboard = {
    "annotations": {"list": []},
    "editable": True,
    "fiscalYearStartMonth": 0,
    "graphTooltip": 1,
    "id": None,
    "links": [],
    "liveNow": False,
    "panels": [
        create_scatter_panel(),
        create_temperature_trend_panel(),
        create_weather_heatmap_panel(),
        create_weather_summary_panel(),
        create_data_table_panel()
    ],
    "refresh": "30s",
    "schemaVersion": 38,
    "style": "dark",
    "tags": ["route-91m", "weather", "correlation"],
    "templating": {"list": []},
    "time": {"from": "now-7d", "to": "now"},
    "timepicker": {},
    "timezone": "Asia/Hong_Kong",
    "title": "🌤️ Route 91M - Weather Correlation Analysis",
    "uid": "route-91m-weather",
    "version": 1
}

# Save to file
output_file = "/Users/shiyangxu/Desktop/hk-bus/grafana/dashboards/route-91m-weather-correlation.json"
with open(output_file, 'w') as f:
    json.dump(dashboard, f, indent=2)

print(f"✅ Dashboard created: {output_file}")
print(f"📊 Panels created:")
print(f"   1. Wait Time vs Rainfall (Scatter)")
print(f"   2. Temperature & Wait Time Trend (Time Series)")
print(f"   3. Weather Impact Heatmap (Hour × Condition)")
print(f"   4. Weather Impact Summary (Bar)")
print(f"   5. Detailed Data Table")

