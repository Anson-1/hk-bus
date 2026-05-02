import React, { useState, useCallback } from 'react';
import './App.css';
import SearchBar from './components/SearchBar';
import RouteDetailsView from './components/RouteDetailsView';

function App() {
  const [selectedRoute, setSelectedRoute] = useState(null);

  const handleRouteSelect = useCallback((routeInfo) => {
    setSelectedRoute(routeInfo);
  }, []);

  return (
    <div className="app">
      <header className="header">
        <h1>🚌 Hong Kong Bus Tracker</h1>
        <p>Real-time ETA tracking — KMB & Citybus</p>
      </header>

      <div className="container">
        <SearchBar onSelectRoute={handleRouteSelect} />

        {selectedRoute && (
          <div className="content">
            <div className="left-panel">
              <RouteDetailsView routeNum={selectedRoute.route} bound={selectedRoute.bound} company={selectedRoute.company || 'KMB'} />
            </div>
          </div>
        )}

        {!selectedRoute && (
          <div className="welcome">
            <div className="welcome-box">
              <h2>Welcome to HK Bus Tracker</h2>
              <p>Search for a bus route to see real-time arrival times at all stops</p>
              <ul>
                <li>🔍 Search by route number (e.g., '1', '103', '2B')</li>
                <li>⏱️ See real-time bus arrival times at each stop</li>
                <li>📊 View based on live ETA data from KMB API</li>
              </ul>
            </div>
          </div>
        )}
      </div>

      <footer className="footer">
        <p>Data sources: KMB ETABus API & Citybus API | Built with Kafka · PostgreSQL · Redis · Prometheus · Grafana</p>
      </footer>
    </div>
  );
}

export default App;
