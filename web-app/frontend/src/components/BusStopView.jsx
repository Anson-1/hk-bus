import React from 'react';

function BusStopView({ stop, etas, loading }) {
  if (!stop) {
    return <div className="loading">Loading...</div>;
  }

  return (
    <div>
      <div className="stop-info">
        <div className="stop-id">{stop.stop_id}</div>
        <h2>{stop.name_tc || stop.name_en || 'Bus Stop'}</h2>
        {stop.name_en && <p>{stop.name_en}</p>}
        {stop.lat && stop.long && (
          <p>📍 {stop.lat.toFixed(4)}, {stop.long.toFixed(4)}</p>
        )}
      </div>

      <h3 style={{ marginBottom: '1rem', color: '#333' }}>
        Incoming Buses ({etas.length})
      </h3>

      {loading ? (
        <div className="loading">Loading ETAs...</div>
      ) : etas.length === 0 ? (
        <div style={{
          padding: '2rem',
          textAlign: 'center',
          color: '#999',
          backgroundColor: '#f5f5f5',
          borderRadius: '8px'
        }}>
          <p>No bus information available for this stop</p>
          <p style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}>
            Try searching for another stop
          </p>
        </div>
      ) : (
        <div className="eta-list">
          {etas.map((eta, idx) => (
            <div
              key={idx}
              className={`eta-card ${eta.is_delayed ? 'eta-delayed' : ''}`}
            >
              <div className="eta-route">
                <strong>Route {eta.route}</strong>
                {eta.route_name && (
                  <div style={{ fontSize: '0.85rem', color: '#666', marginTop: '0.3rem' }}>
                    {eta.route_name}
                  </div>
                )}
              </div>
              <div className="eta-time">
                ⏱️ Wait time: {Math.max(0, Math.round(eta.wait_sec / 60))} min
              </div>
              {eta.sample_count && (
                <div className="eta-samples">
                  Based on {eta.sample_count} sample{eta.sample_count > 1 ? 's' : ''}
                </div>
              )}
              {eta.is_delayed && (
                <div style={{
                  marginTop: '0.5rem',
                  fontSize: '0.85rem',
                  color: '#ff6b6b',
                  fontWeight: 600
                }}>
                  ⚠️ Delayed
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default BusStopView;
