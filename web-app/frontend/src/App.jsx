import React, { useState, useCallback } from 'react';
import './App.css';
import SearchBar from './components/SearchBar';
import RouteDetailsView from './components/RouteDetailsView';
import MapDisplay from './components/MapDisplay';

function App() {
  const [selectedRoute, setSelectedRoute] = useState(null);

  const handleRouteSelect = useCallback((routeNum) => {
    setSelectedRoute(routeNum);
  }, []);

  return (
    <div className="app">
      <header className="header">
        <h1>🚌 Hong Kong Bus Tracker</h1>
        <p>Real-time ETA tracking for KMB buses</p>
      </header>

      <div className="container">
        <SearchBar onSelectRoute={handleRouteSelect} />

        {selectedRoute && (
          <div className="content">
            <div className="left-panel">
              <RouteDetailsView routeNum={selectedRoute} />
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
        <p>Data source: KMB ETABus API | Last updated: {new Date().toLocaleTimeString()}</p>
      </footer>
    </div>
  );
}

export default App;
