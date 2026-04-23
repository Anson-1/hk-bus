import React, { useEffect } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

function MapDisplay({ stop }) {
  useEffect(() => {
    if (!stop || !stop.lat || !stop.long) return;

    // Initialize map centered on the bus stop
    const map = L.map('map').setView(
      [stop.lat, stop.long],
      16
    );

    // Add OpenStreetMap tile layer
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(map);

    // Add marker for the bus stop
    const marker = L.marker([stop.lat, stop.long], {
      title: stop.name_en || stop.name_tc
    });

    marker.bindPopup(`
      <div style="font-weight: bold;">${stop.name_tc || stop.name_en}</div>
      <div style="font-size: 0.85rem; color: #666;">Stop ID: ${stop.stop_id}</div>
    `);

    marker.addTo(map);
    marker.openPopup();

    // Add a circle to show the stop area
    L.circle([stop.lat, stop.long], {
      color: '#667eea',
      fillColor: '#667eea',
      fillOpacity: 0.1,
      radius: 50,
      weight: 2
    }).addTo(map);

    // Cleanup
    return () => {
      map.remove();
    };
  }, [stop]);

  return (
    <div className="map-container">
      <div id="map" style={{ width: '100%', height: '100%' }}></div>
    </div>
  );
}

export default MapDisplay;
