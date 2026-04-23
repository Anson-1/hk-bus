import React, { useEffect, useState } from 'react';
import axios from 'axios';
import './RouteDetailsView.css';

function RouteDetailsView({ routeNum }) {
  const [routeInfo, setRouteInfo] = useState(null);
  const [stops, setStops] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const API_BASE = '/api';

  useEffect(() => {
    const fetchRouteDetails = async () => {
      try {
        setLoading(true);
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
      fetchRouteDetails();
    }
  }, [routeNum]);

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
                      {stop.is_delayed && (
                        <div className="eta-delayed">
                          ⚠️ Delayed
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

      <div className="route-footer">
        <small>Data source: KMB ETABus API | Last updated: {new Date().toLocaleTimeString()}</small>
      </div>
    </div>
  );
}

export default RouteDetailsView;
