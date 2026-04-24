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

function RouteDetailsView({ routeNum }) {
  const [routeInfo, setRouteInfo] = useState(null);
  const [stops, setStops] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [userLocation, setUserLocation] = useState(null);

  const API_BASE = '/api';

  useEffect(() => {
    const fetchRouteDetails = async () => {
      try {
        setError(null);
        
        // Fetch route details and all stops with ETAs
        const response = await axios.get(`${API_BASE}/route/${routeNum}`);
        setRouteInfo(response.data.route);
        setStops(response.data.stops || []);
      } catch (err) {
        console.error('Error fetching route details:', err);
        setError(err.response?.data?.message || 'Failed to fetch route details');
      } finally {
        setLoading(false);
      }
    };

    if (routeNum) {
      // Initial fetch
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

      // Cleanup on unmount or route change
      return () => {
        if (routeNum) {
          socket.emit('unsubscribe', routeNum);
        }
        socket.disconnect();
      };
    }
  }, [routeNum]);

  // Get user location for map
  useEffect(() => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          setUserLocation([position.coords.latitude, position.coords.longitude]);
        },
        (err) => {
          console.warn('Could not get user location:', err);
          // Default to Hong Kong center if location unavailable
          setUserLocation([22.3193, 114.1694]);
        }
      );
    }
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
        <h2>Route {routeNum}</h2>
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
                      <>
                        <div className="eta-time">
                          ⏱️ {Math.round(stop.wait_sec / 60)} min
                        </div>
                        {stop.sample_count && (
                          <div className="eta-samples">
                            Based on {stop.sample_count} sample{stop.sample_count > 1 ? 's' : ''}
                          </div>
                        )}
                      </>
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
              
              {/* User location marker if available */}
              {userLocation && (
                <Marker position={userLocation}>
                  <Popup>Your Location</Popup>
                </Marker>
              )}

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
                          <>⏱️ {Math.round(stop.wait_sec / 60)} min</>
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
        <small>Data source: KMB ETABus API | Last updated: {new Date().toLocaleTimeString()}</small>
      </div>
    </div>
  );
}

export default RouteDetailsView;
