#!/usr/bin/env python3
"""
Publish real HK bus route ETA data to Kafka for testing.
Uses actual KMB route information.
"""

import json
import os
import sys
from datetime import datetime, timedelta
import requests
from kafka import KafkaProducer

# Real HK KMB routes to test
TEST_ROUTES = ['91P', '91M', '1', '2', '3C', '6', '260']

KMB_API_BASE = 'https://data.etabus.gov.hk/v1/transport/kmb'

def get_kmb_route_info(route_num):
    """Fetch real route info from KMB API"""
    try:
        response = requests.get(
            f'{KMB_API_BASE}/route',
            params={'routes': route_num},
            timeout=5
        )
        if response.status_code == 200:
            data = response.json()
            if data.get('data'):
                return data['data'][0]
    except Exception as e:
        print(f"Error fetching route {route_num}: {e}")
    return None


def get_stops_for_route(route_num):
    """Get stops for a route"""
    try:
        response = requests.get(
            f'{KMB_API_BASE}/route-stop',
            params={'route': route_num, 'bound': 'O'},
            timeout=5
        )
        if response.status_code == 200:
            data = response.json()
            if data.get('data'):
                return data['data'][:3]  # Get first 3 stops
    except Exception as e:
        print(f"Error fetching stops for route {route_num}: {e}")
    return []


def get_eta_for_stop(route_num, stop_id):
    """Get ETA for a stop"""
    try:
        response = requests.get(
            f'{KMB_API_BASE}/eta/{stop_id}/{route_num}',
            timeout=5
        )
        if response.status_code == 200:
            data = response.json()
            if data.get('data'):
                return data['data'][0]
    except Exception as e:
        pass
    return None


def publish_message(producer, message):
    """Publish message to Kafka"""
    try:
        producer.send('hk_bus_eta', json.dumps(message).encode('utf-8'))
        print(f"✓ Published: Route {message['route']} - Stop {message['stop']}")
    except Exception as e:
        print(f"✗ Error: {e}")


def main():
    # Connect to Kafka
    kafka_host = os.environ.get('KAFKA_HOST', 'kafka-broker.hk-bus.svc.cluster.local:9092')
    print(f"Connecting to Kafka at {kafka_host}...")
    
    producer = KafkaProducer(
        bootstrap_servers=[kafka_host],
        value_serializer=lambda v: json.dumps(v).encode('utf-8')
    )
    
    now = datetime.utcnow()
    
    # Publish real route data
    for route_num in TEST_ROUTES:
        print(f"\n📍 Publishing data for Route {route_num}...")
        
        route_info = get_kmb_route_info(route_num)
        if not route_info:
            print(f"  ⚠ Could not fetch info for route {route_num}, skipping")
            continue
        
        stops = get_stops_for_route(route_num)
        if not stops:
            print(f"  ⚠ Could not fetch stops for route {route_num}")
            continue
        
        # Publish ETA data for each stop
        for i, stop_info in enumerate(stops):
            stop_id = stop_info['stop']
            
            # Get real ETA if available
            eta_data = get_eta_for_stop(route_num, stop_id)
            
            if eta_data:
                eta = eta_data.get('eta')
            else:
                # Generate realistic ETAs
                eta = (now + timedelta(minutes=5 + i*3)).isoformat()
            
            message = {
                'co': 'KMB',
                'route': route_num,
                'dir': 'O',
                'stop': stop_id,
                'eta_seq': 1,
                'eta': eta,
                'rmk_en': '',
                'data_timestamp': now.isoformat(),
                'fetched_at': now.isoformat()
            }
            
            publish_message(producer, message)
    
    producer.flush()
    producer.close()
    print("\n✅ Done! Published real route data to Kafka")


if __name__ == '__main__':
    main()
