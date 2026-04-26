#!/usr/bin/env python3
"""
Hong Kong Weather Fetcher for Route 91M Dashboard
Collects hourly weather data from HK government API
Stores in PostgreSQL for correlation with bus ETA data
"""

import os
import json
import logging
import time
from datetime import datetime
import requests
import psycopg2
from psycopg2.extras import Json

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Configuration
WEATHER_API_URL = "https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=en"
FETCH_INTERVAL = 3600  # Hourly
DB_CONNECT_TIMEOUT = 5
MAX_RETRIES = 3
RETRY_DELAY = 5

def get_db_connection():
    """Connect to PostgreSQL database"""
    try:
        conn = psycopg2.connect(
            host=os.environ.get('POSTGRES_HOST', 'postgres-db'),
            port=int(os.environ.get('POSTGRES_PORT', 5432)),
            database=os.environ.get('POSTGRES_DB', 'hk_bus'),
            user=os.environ.get('POSTGRES_USER', 'postgres'),
            password=os.environ.get('POSTGRES_PASSWORD', 'postgres'),
            connect_timeout=DB_CONNECT_TIMEOUT
        )
        return conn
    except Exception as e:
        logger.error(f"❌ Failed to connect to PostgreSQL: {e}")
        raise

def fetch_weather_data():
    """Fetch current weather data from HK government API"""
    try:
        logger.debug(f"📡 Fetching from {WEATHER_API_URL}")
        response = requests.get(WEATHER_API_URL, timeout=10)
        response.raise_for_status()
        
        data = response.json()
        logger.debug(f"✅ Weather data received: {response.status_code}")
        
        return data
    except Exception as e:
        logger.error(f"❌ Failed to fetch weather data: {e}")
        raise

def extract_weather_metrics(data):
    """Extract key weather metrics for Route 91M area (Tuen Mun)"""
    try:
        # Extract temperature data
        temps = []
        temp_tuen_mun = None
        
        if 'temperature' in data and data['temperature'].get('data'):
            for temp_data in data['temperature']['data']:
                if 'value' in temp_data:
                    value = float(temp_data['value'])
                    temps.append(value)
                    
                    # Capture Tuen Mun specifically
                    if 'Tuen Mun' in temp_data.get('place', ''):
                        temp_tuen_mun = value
        
        temp_c_avg = sum(temps) / len(temps) if temps else None
        temp_c_min = min(temps) if temps else None
        temp_c_max = max(temps) if temps else None
        
        # Extract rainfall for key Route 91M areas
        rainfall_tuen_mun = None
        rainfall_tsuen_wan = None
        rainfall_max = None
        
        if 'rainfall' in data and data['rainfall'].get('data'):
            rainfall_values = []
            
            for rain_data in data['rainfall']['data']:
                place = rain_data.get('place', '')
                max_rain = rain_data.get('max', 0)
                
                if max_rain is not None:
                    rainfall_values.append(float(max_rain))
                
                if 'Tuen Mun' in place:
                    rainfall_tuen_mun = float(max_rain) if max_rain is not None else 0
                elif 'Tsuen Wan' in place:
                    rainfall_tsuen_wan = float(max_rain) if max_rain is not None else 0
            
            rainfall_max = max(rainfall_values) if rainfall_values else None
        
        # Extract humidity
        humidity = None
        if 'humidity' in data and data['humidity'].get('data'):
            humidity_data = data['humidity']['data'][0]
            if 'value' in humidity_data:
                humidity = float(humidity_data['value'])
        
        # Determine weather condition
        if rainfall_tuen_mun and rainfall_tuen_mun > 0.5:
            condition = 'Rainy'
        elif rainfall_tuen_mun and rainfall_tuen_mun > 0:
            condition = 'Light Rain'
        else:
            condition = 'Clear'
        
        # Extract timestamp from API response
        timestamp_str = data.get('updateTime', datetime.now().isoformat())
        
        metrics = {
            'timestamp': timestamp_str,
            'temp_c_avg': temp_c_avg,
            'temp_c_min': temp_c_min,
            'temp_c_max': temp_c_max,
            'temp_c_tuen_mun': temp_tuen_mun,
            'rainfall_tuen_mun_mm': rainfall_tuen_mun,
            'rainfall_tsuen_wan_mm': rainfall_tsuen_wan,
            'rainfall_max_hk_mm': rainfall_max,
            'humidity_pct': humidity,
            'weather_condition': condition,
            'raw_data': data
        }
        
        logger.info(
            f"📊 Extracted: {condition} | "
            f"Temp: {temp_c_avg:.1f}°C | "
            f"Rain (Tuen Mun): {rainfall_tuen_mun}mm | "
            f"Humidity: {humidity}%"
        )
        
        return metrics
        
    except Exception as e:
        logger.error(f"❌ Failed to extract weather metrics: {e}")
        raise

def store_weather_data(conn, metrics):
    """Store weather metrics in PostgreSQL"""
    try:
        cursor = conn.cursor()
        
        # Parse timestamp to ensure correct format
        timestamp_str = metrics['timestamp']
        # Handle ISO format with timezone: "2026-04-25T20:02:00+08:00"
        if '+' in timestamp_str:
            timestamp_str = timestamp_str.split('+')[0]  # Remove timezone
        
        # Insert with ON CONFLICT to handle duplicate timestamps
        query = """
        INSERT INTO weather_hourly 
        (timestamp, temp_c_avg, temp_c_min, temp_c_max, temp_c_tuen_mun,
         rainfall_tuen_mun_mm, rainfall_tsuen_wan_mm, rainfall_max_hk_mm,
         humidity_pct, weather_condition, raw_data)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (timestamp) DO UPDATE SET
            temp_c_avg = EXCLUDED.temp_c_avg,
            temp_c_min = EXCLUDED.temp_c_min,
            temp_c_max = EXCLUDED.temp_c_max,
            temp_c_tuen_mun = EXCLUDED.temp_c_tuen_mun,
            rainfall_tuen_mun_mm = EXCLUDED.rainfall_tuen_mun_mm,
            rainfall_tsuen_wan_mm = EXCLUDED.rainfall_tsuen_wan_mm,
            rainfall_max_hk_mm = EXCLUDED.rainfall_max_hk_mm,
            humidity_pct = EXCLUDED.humidity_pct,
            weather_condition = EXCLUDED.weather_condition,
            raw_data = EXCLUDED.raw_data
        """
        
        cursor.execute(query, (
            timestamp_str,
            metrics['temp_c_avg'],
            metrics['temp_c_min'],
            metrics['temp_c_max'],
            metrics['temp_c_tuen_mun'],
            metrics['rainfall_tuen_mun_mm'],
            metrics['rainfall_tsuen_wan_mm'],
            metrics['rainfall_max_hk_mm'],
            metrics['humidity_pct'],
            metrics['weather_condition'],
            Json(metrics['raw_data'])
        ))
        
        conn.commit()
        logger.info(f"✅ Weather data stored successfully")
        
    except Exception as e:
        conn.rollback()
        logger.error(f"❌ Failed to store weather data: {e}")
        raise
    finally:
        cursor.close()

def health_check(conn):
    """Check database health"""
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM weather_hourly")
        count = cursor.fetchone()[0]
        cursor.close()
        logger.debug(f"Database health: {count} weather records")
        return True
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        return False

def fetch_and_store():
    """Main fetch cycle"""
    conn = None
    try:
        # Connect to database
        conn = get_db_connection()
        logger.info("✅ Connected to PostgreSQL")
        
        # Check health
        if not health_check(conn):
            logger.warning("⚠️  Database health check failed but continuing...")
        
        # Fetch weather data
        weather_data = fetch_weather_data()
        
        # Extract metrics
        metrics = extract_weather_metrics(weather_data)
        
        # Store in database
        store_weather_data(conn, metrics)
        
        return True
        
    except Exception as e:
        logger.error(f"❌ Fetch cycle failed: {e}")
        return False
    finally:
        if conn:
            conn.close()

def main():
    """Main loop - run continuously"""
    logger.info("=" * 70)
    logger.info("🌤️  Hong Kong Weather Fetcher Started")
    logger.info(f"Update interval: {FETCH_INTERVAL}s ({FETCH_INTERVAL/3600:.0f} hour)")
    logger.info("=" * 70)
    
    # Allow container to start gracefully
    time.sleep(5)
    
    cycle = 0
    while True:
        try:
            cycle += 1
            logger.info(f"\n📍 Fetch cycle #{cycle}")
            logger.info(f"🕐 Time: {datetime.now()}")
            
            success = fetch_and_store()
            
            if success:
                logger.info("✅ Cycle completed successfully")
            else:
                logger.warning("⚠️  Cycle had errors but will retry")
            
            # Wait for next cycle
            logger.debug(f"⏰ Waiting {FETCH_INTERVAL}s until next fetch...")
            time.sleep(FETCH_INTERVAL)
            
        except KeyboardInterrupt:
            logger.info("\n🛑 Interrupted by user")
            break
        except Exception as e:
            logger.error(f"💥 Unexpected error in main loop: {e}")
            logger.info(f"Retrying in {RETRY_DELAY}s...")
            time.sleep(RETRY_DELAY)

if __name__ == '__main__':
    main()
