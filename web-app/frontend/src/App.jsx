import React, { useState, useCallback } from 'react';
import './App.css';
import SearchBar from './components/SearchBar';
import RouteDetailsView from './components/RouteDetailsView';
import MtrView from './components/MtrView';

function App() {
  const [activeTab, setActiveTab] = useState('bus');
  const [selectedRoute, setSelectedRoute] = useState(null);

  const handleRouteSelect = useCallback((routeInfo) => {
    setSelectedRoute(routeInfo);
  }, []);

  return (
    <div className="app">
      <header className="header">
        <h1>🚌 Hong Kong Transit Tracker</h1>
        <p>Real-time ETA tracking — KMB & MTR</p>
      </header>

      <div className="main-tabs">
        <button
          className={`main-tab ${activeTab === 'bus' ? 'active' : ''}`}
          onClick={() => setActiveTab('bus')}
        >
          🚌 Bus (KMB)
        </button>
        <button
          className={`main-tab ${activeTab === 'mtr' ? 'active' : ''}`}
          onClick={() => setActiveTab('mtr')}
        >
          🚇 MTR
        </button>
      </div>

      <div className="container">
        {activeTab === 'bus' && (
          <>
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
                  <h2>Welcome to HK Transit Tracker</h2>
                  <p>Search for a bus route to see real-time arrival times at all stops</p>
                  <ul>
                    <li>🔍 Search by route number (e.g., '1', '103', '2B')</li>
                    <li>⏱️ See real-time bus arrival times at each stop</li>
                    <li>📊 View based on live ETA data from KMB API</li>
                  </ul>
                </div>
              </div>
            )}
          </>
        )}

        {activeTab === 'mtr' && <MtrView />}
      </div>

      <footer className="footer">
        <p>Data sources: KMB API & MTR API | Built with PostgreSQL · Grafana · Kubernetes</p>
      </footer>
    </div>
  );
}

export default App;
