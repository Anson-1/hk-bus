import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import './MtrView.css';

export default function MtrView() {
  const [lines, setLines] = useState({});
  const [selectedLine, setSelectedLine] = useState('');
  const [selectedStation, setSelectedStation] = useState('');
  const [eta, setEta] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const intervalRef = useRef(null);

  useEffect(() => {
    axios.get('/api/mtr-lines').then(r => {
      setLines(r.data);
      const firstLine = Object.keys(r.data)[0];
      if (firstLine) {
        setSelectedLine(firstLine);
        const firstStation = Object.keys(r.data[firstLine].stations)[0];
        if (firstStation) setSelectedStation(firstStation);
      }
    });
  }, []);

  const fetchEta = async (line, station) => {
    if (!line || !station) return;
    setLoading(true);
    setError(null);
    try {
      const r = await axios.get('/api/mtr-eta', { params: { line, station } });
      setEta(r.data);
    } catch {
      setError('Failed to fetch ETA. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!selectedLine || !selectedStation) return;
    fetchEta(selectedLine, selectedStation);
    clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => fetchEta(selectedLine, selectedStation), 30000);
    return () => clearInterval(intervalRef.current);
  }, [selectedLine, selectedStation]);

  const handleLineChange = (line) => {
    setSelectedLine(line);
    setSelectedStation('');
    setEta(null);
    const firstStation = Object.keys(lines[line]?.stations || {})[0];
    if (firstStation) setSelectedStation(firstStation);
  };

  const stations = lines[selectedLine]?.stations || {};

  return (
    <div className="mtr-view">
      <div className="mtr-selectors">
        <div className="mtr-selector-group">
          <label>Line</label>
          <select value={selectedLine} onChange={e => handleLineChange(e.target.value)}>
            {Object.entries(lines).map(([code, info]) => (
              <option key={code} value={code}>{info.name} ({code})</option>
            ))}
          </select>
        </div>
        <div className="mtr-selector-group">
          <label>Station</label>
          <select value={selectedStation} onChange={e => setSelectedStation(e.target.value)}>
            {Object.entries(stations).map(([code, name]) => (
              <option key={code} value={code}>{name}</option>
            ))}
          </select>
        </div>
        <button className="mtr-refresh-btn" onClick={() => fetchEta(selectedLine, selectedStation)} disabled={loading}>
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {error && <div className="mtr-error">{error}</div>}

      {eta && (
        <div className="mtr-eta-container">
          <div className="mtr-station-header">
            <h2>{eta.station_name}</h2>
            <span className="mtr-line-badge">{eta.line_name}</span>
            {eta.curr_time && <span className="mtr-updated">Updated: {eta.curr_time.slice(11, 16)}</span>}
          </div>

          <div className="mtr-directions">
            <EtaDirection label="Towards ↑" trains={eta.up} />
            <EtaDirection label="Towards ↓" trains={eta.down} />
          </div>
        </div>
      )}

      {!eta && !loading && !error && (
        <div className="mtr-placeholder">Select a line and station to see live ETAs</div>
      )}
    </div>
  );
}

function EtaDirection({ label, trains }) {
  if (!trains || trains.length === 0) return null;
  return (
    <div className="mtr-direction">
      <h3>{label}</h3>
      <div className="mtr-trains">
        {trains.map((t, i) => (
          <div key={i} className={`mtr-train mtr-train-${i === 0 ? 'next' : 'later'}`}>
            <div className="mtr-train-dest">→ {t.dest_name}</div>
            <div className="mtr-train-wait">
              {t.wait_min === 0 ? 'Arriving' : `${t.wait_min} min`}
            </div>
            <div className="mtr-train-meta">Plat {t.platform} · {t.time?.slice(11, 16)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
