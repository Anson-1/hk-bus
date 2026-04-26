#!/usr/bin/env python3
"""
Weather Data Exploration Script
Understand the structure of HK weather API data
Similar to data.py but for weather correlation analysis
"""

import requests
import json
from pprint import pprint
from datetime import datetime

print("🌤️  Hong Kong Weather API Exploration")
print("=" * 70)

# Fetch weather data
WEATHER_API = "https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=en"

print(f"\n📡 Fetching from: {WEATHER_API}\n")
response = requests.get(WEATHER_API)
data = response.json()

print(f"✅ API Status: {response.status_code}")
print(f"📅 Response Time: {datetime.now()}\n")

# Explore data structure
print("=" * 70)
print("1. TOP-LEVEL DATA STRUCTURE")
print("=" * 70)
print(f"Keys available: {list(data.keys())}\n")

# Update time info
print("Update Information:")
if 'updateTime' in data:
    print(f"  • updateTime: {data['updateTime']}")
if 'iconUpdateTime' in data:
    print(f"  • iconUpdateTime: {data['iconUpdateTime']}\n")

# Temperature data
print("=" * 70)
print("2. TEMPERATURE DATA")
print("=" * 70)
if 'temperature' in data:
    temps = data['temperature'].get('data', [])
    print(f"Number of temperature stations: {len(temps)}\n")
    print(f"{'Place':<30} | {'Value':<10} | {'Unit':<5}")
    print("-" * 50)
    for temp_data in temps[:10]:  # Show first 10
        place = temp_data.get('place', 'Unknown')[:28]
        value = temp_data.get('value', 'N/A')
        unit = temp_data.get('unit', '')
        print(f"{place:<30} | {str(value):<10} | {unit:<5}")
    if len(temps) > 10:
        print(f"... and {len(temps) - 10} more stations")

# Rainfall data
print("\n" + "=" * 70)
print("3. RAINFALL DATA")
print("=" * 70)
if 'rainfall' in data:
    rainfall = data['rainfall'].get('data', [])
    print(f"Number of rainfall zones: {len(rainfall)}\n")
    print(f"{'District':<30} | {'Max (mm)':<12} | {'Main':<10}")
    print("-" * 55)
    for rain_data in rainfall:
        place = rain_data.get('place', 'Unknown')[:28]
        max_rain = rain_data.get('max', 'N/A')
        is_main = rain_data.get('main', 'FALSE')
        print(f"{place:<30} | {str(max_rain):<12} | {is_main:<10}")

# Find Tuen Mun specifically (Route 91M area)
print("\n" + "=" * 70)
print("4. ROUTE 91M AREA (TUEN MUN)")
print("=" * 70)
tuen_mun_found = False
if 'rainfall' in data:
    for rain_data in data['rainfall']['data']:
        if 'Tuen Mun' in rain_data.get('place', ''):
            print(f"✅ Found Tuen Mun rainfall data:")
            print(f"   Place: {rain_data.get('place')}")
            print(f"   Max Rainfall: {rain_data.get('max')} mm")
            print(f"   Is Main Station: {rain_data.get('main')}")
            tuen_mun_found = True

if not tuen_mun_found:
    print("❌ Tuen Mun not found in rainfall data")
    print("   Alternative: Use Tsuen Wan or Yuen Long as proxy")

# Humidity data
print("\n" + "=" * 70)
print("5. HUMIDITY DATA")
print("=" * 70)
if 'humidity' in data:
    humidity = data['humidity'].get('data', [])
    print(f"Number of humidity entries: {len(humidity)}\n")
    for i, h_data in enumerate(humidity):
        print(f"Entry {i}:")
        for key, val in h_data.items():
            print(f"  • {key}: {val}")
        if i >= 2:  # Show first 3
            print(f"... and {len(humidity) - 3} more entries")
            break

# Wind data (if available)
print("\n" + "=" * 70)
print("6. WIND DATA (Check if available)")
print("=" * 70)
wind_keys = [k for k in data.keys() if 'wind' in k.lower()]
if wind_keys:
    print(f"✅ Wind data available: {wind_keys}")
    for key in wind_keys:
        print(f"\n{key}:")
        pprint(data[key], depth=2)
else:
    print("❌ No wind data in current API response")

# Daily forecasts (if available)
print("\n" + "=" * 70)
print("7. OTHER USEFUL DATA")
print("=" * 70)
other_keys = [k for k in data.keys() 
              if k not in ['temperature', 'rainfall', 'humidity', 'updateTime', 'iconUpdateTime', 'icon', 'tcmessage']]
print(f"Other keys in response: {other_keys}")

for key in other_keys:
    if key not in ['rawData']:
        print(f"\n{key}:")
        val = data.get(key)
        if isinstance(val, (list, dict)):
            pprint(val, depth=1)
        else:
            print(f"  {val}")

# Summary for database design
print("\n" + "=" * 70)
print("8. DATA SCHEMA RECOMMENDATIONS FOR DATABASE")
print("=" * 70)
print("""
For weather_hourly table, we can extract:

Required fields (always available):
  ✅ timestamp: updateTime from API
  ✅ temp_c: Average of all temperature stations
  ✅ rainfall_mm: Tuen Mun (Route 91M area)
  ✅ humidity_pct: Extracted from humidity data
  
Optional fields (might be missing):
  ⚠️  wind_speed: Not in current response
  ⚠️  wind_direction: Not in current response
  ⚠️  visibility: Not in current response

Derived fields (computed):
  ✅ weather_condition: "Rainy" if rainfall > 0, else "Clear"
  ✅ raw_data: Store entire JSON response for audit

Update frequency: Hourly from API
  • updateTime indicates when data was collected
  • Can run fetcher every hour
""")

# Check data consistency
print("\n" + "=" * 70)
print("9. DATA QUALITY CHECKS")
print("=" * 70)

print(f"Temperature stations: {len(data['temperature']['data'])} ✅")
print(f"Rainfall zones: {len(data['rainfall']['data'])} ✅")

temps_with_values = sum(1 for t in data['temperature']['data'] if t.get('value'))
print(f"Temperature readings with values: {temps_with_values}/{len(data['temperature']['data'])}")

rainfall_with_values = sum(1 for r in data['rainfall']['data'] if r.get('max') is not None)
print(f"Rainfall readings with values: {rainfall_with_values}/{len(data['rainfall']['data'])}")

if data['humidity'].get('data'):
    humidity_with_values = sum(1 for h in data['humidity']['data'] if h.get('value'))
    print(f"Humidity readings with values: {humidity_with_values}/{len(data['humidity']['data'])}")

print("\n✅ Exploration complete!")
print("\nNext steps:")
print("1. Decide which fields to store")
print("2. Design database schema")
print("3. Create weather fetcher script")
print("4. Integrate with docker-compose")
print("5. Create Grafana correlation panels")
