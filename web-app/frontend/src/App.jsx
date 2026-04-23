import React, { useState, useCallback } from 'react';
import './App.css';
import SearchBar from './components/SearchBar';
import BusStopView from './components/BusStopView';
import MapDisplay from './components/MapDisplay';

function App() {
  const [selectedStop, setSelectedStop] = useState(null);
  const [etas, setETAs] = useState([]);
  const [loading, setLoading] = useState(false);

  const handleStopSelect = useCallback(async (stopId) => {
    setLoading(true);
    try {
      const response = await fetch(
        `/api/eta/${stopId}`
      );
      const data = await response.json();
      setSelectedStop(data.stop);
      setETAs(data.etas);
    } catch (error) {
      console.error('Error fetching ETAs:', error);
      alert('Failed to fetch bus information');
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <div className="app">
      <header className="header">
        <h1>🚌 Hong Kong Bus Tracker</h1>
        <p>Real-time ETA tracking for KMB buses</p>
      </header>

      <div className="container">
        <SearchBar onSelectStop={handleStopSelect} />

        {selectedStop && (
          <div className="content">
            <div className="left-panel">
              <BusStopView
                stop={selectedStop}
                etas={etas}
                loading={loading}
              />
            </div>
            <div className="right-panel">
              <MapDisplay stop={selectedStop} />
            </div>
          </div>
        )}

        {!selectedStop && (
          <div className="welcome">
            <div className="welcome-box">
              <h2>Welcome to HK Bus Tracker</h2>
              <p>Search for a bus stop to see real-time ETAs</p>
              <ul>
                <li>📍 Search by stop ID or name (in Chinese or English)</li>
                <li>🗺️ View the bus stop on an interactive map</li>
                <li>⏱️ See real-time bus arrival times</li>
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
