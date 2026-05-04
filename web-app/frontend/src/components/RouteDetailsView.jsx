import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { io } from 'socket.io-client';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import './RouteDetailsView.css';

// Fix Leaflet marker icons
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

function RouteDetailsView({ routeNum, bound = 'O', company = 'KMB' }) {
  const [routeInfo, setRouteInfo] = useState(null);
  const [stops, setStops] = useState([]);
  const [avgWait, setAvgWait] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [userLocation, setUserLocation] = useState(null);

  const API_BASE = '/api';

  useEffect(() => {
    const fetchRouteDetails = async () => {
      try {
        setError(null);

        const liveEndpoint = `${API_BASE}/route-live/${routeNum}`;

        const [liveRes, avgRes] = await Promise.allSettled([
          axios.get(liveEndpoint, { params: { bound } }),
          axios.get(`${API_BASE}/avg-wait/${routeNum}/${bound}`),
        ]);

        if (liveRes.status === 'fulfilled') {
          setRouteInfo(liveRes.value.data.route);
          setStops(liveRes.value.data.stops || []);
        }
        if (avgRes.status === 'fulfilled') {
          setAvgWait(avgRes.value.data.stops || {});
        }
      } catch (err) {
        console.error('Error fetching route details:', err);
        setError(err.response?.data?.message || 'Failed to fetch route details');
      } finally {
        setLoading(false);
      }
    };

    if (routeNum) {
      setLoading(true);
      fetchRouteDetails();

      // Connect to WebSocket and subscribe to route updates
      const socket = io(window.location.origin, {
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: 5
      });

      socket.on('connect', () => {
        console.log('[WebSocket] Connected, subscribing to route:', routeNum);
        socket.emit('subscribe', routeNum);
      });

      socket.on('route_update', (message) => {
        console.log('[WebSocket] Received route update:', routeNum);
        if (message.data) {
          setRouteInfo(message.data.route);
          setStops(message.data.stops || []);
          setError(null);
        }
      });

      socket.on('error', (err) => {
        console.error('[WebSocket] Error:', err);
      });

      socket.on('disconnect', () => {
        console.log('[WebSocket] Disconnected');
      });

      // Poll live ETA data every 1 second for real-time updates
      const pollInterval = setInterval(() => {
        fetchRouteDetails();
      }, 1000);

      // Cleanup on unmount or route change
      return () => {
        if (routeNum) {
          socket.emit('unsubscribe', routeNum);
        }
        socket.disconnect();
        clearInterval(pollInterval);
      };
    }
  }, [routeNum, bound, company]);

  // Default map center to Hong Kong
  useEffect(() => {
    setUserLocation([22.3193, 114.1694]);
  }, []);

  if (loading) {
    return <div className="route-view loading">Loading route details...</div>;
  }

  if (error) {
    return <div className="route-view error">⚠️ {error}</div>;
  }

  if (!routeInfo) {
    return <div className="route-view error">Route not found</div>;
  }

  return (
    <div className="route-details-view">
      <div className="route-header">
        <h2>
          Route {routeNum}
          <span style={{
            fontSize: '0.65rem', fontWeight: 700, color: '#fff', verticalAlign: 'middle',
            background: company === 'CTB' ? '#16a34a' : '#2563eb',
            borderRadius: '5px', padding: '2px 8px', marginLeft: '10px'
          }}>
            {company === 'CTB' ? 'Citybus' : 'KMB'}
          </span>
        </h2>
        <div className="route-destination">
          {routeInfo.name || `${routeInfo.name_en || 'Unknown'}`}
        </div>
        <div className="route-destination-tc">
          {routeInfo.name_tc || ''}
        </div>
      </div>

      <div className="route-content">
        {/* Stops List on Left */}
        <div className="stops-container">
          <h3>Upcoming Stops ({stops.length})</h3>
          {stops.length === 0 ? (
            <div className="no-data">No stops with ETA data available</div>
          ) : (
            <div className="stops-list">
              {stops.map((stop, idx) => (
                <div key={idx} className="stop-card">
                  <div className="stop-sequence">
                    <span className="sequence-number">{idx + 1}</span>
                  </div>
                  <div className="stop-info">
                    <div className="stop-name">
                      {stop.name_en || stop.name || 'Unknown Stop'}
                    </div>
                    <div className="stop-name-tc">
                      {stop.name_tc || ''}
                    </div>
                    <div className="stop-id">
                      Stop ID: {stop.stop_id}
                    </div>
                  </div>
                  <div className="stop-eta">
                    {stop.wait_sec !== null && stop.wait_sec !== undefined ? (
                      <div className="eta-time">
                        ⏱️ {Math.max(0, Math.round(stop.wait_sec / 60))} min
                      </div>
                    ) : (
                      <div className="no-eta">No ETA</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Map on Right */}
        {stops.length > 0 && (
          <div className="map-container">
            <MapContainer
              center={userLocation || [22.3193, 114.1694]}
              zoom={13}
              scrollWheelZoom={true}
              style={{ height: '100%', width: '100%' }}
            >
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              
              {/* Route stops - use real coordinates */}
              {stops.map((stop, idx) => {
                const lat = stop.lat ? parseFloat(stop.lat) : null;
                const lng = stop.lng ? parseFloat(stop.lng) : null;
                
                if (!lat || !lng) return null;
                
                return (
                  <Marker key={idx} position={[lat, lng]}>
                    <Popup>
                      <div style={{ fontSize: '12px', maxWidth: '200px' }}>
                        <strong>{idx + 1}. {stop.name_en}</strong><br/>
                        {stop.name_tc}<br/>
                        {stop.wait_sec !== null ? (
                          <>⏱️ {Math.max(0, Math.round(stop.wait_sec / 60))} min</>
                        ) : (
                          <>No ETA</>
                        )}
                      </div>
                    </Popup>
                  </Marker>
                );
              })}
            </MapContainer>
          </div>
        )}
      </div>

      <div className="route-footer">
        <small>Data source: {company === 'CTB' ? 'Citybus API' : 'KMB ETABus API'} | Last updated: {new Date().toLocaleTimeString()}</small>
      </div>
    </div>
  );
}

export default RouteDetailsView;
