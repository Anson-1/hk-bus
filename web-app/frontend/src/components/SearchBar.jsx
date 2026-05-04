import React, { useState, useCallback, useEffect } from 'react';
import axios from 'axios';

function SearchBar({ onSelectRoute }) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSearch = useCallback(async (q) => {
    if (!q || q.length < 1) { setSuggestions([]); setShowSuggestions(false); return; }
    setLoading(true);
    try {
      const res = await axios.get(`/api/route-search?q=${encodeURIComponent(q)}`);
      setSuggestions(res.data.results || []);
      setShowSuggestions(true);
    } catch {
      setSuggestions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { if (query) handleSearch(query); }, 300);
    return () => clearTimeout(timer);
  }, [query, handleSearch]);

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && suggestions.length > 0) handleSelectSuggestion(suggestions[0]);
  };

  const handleSelectSuggestion = (route) => {
    setQuery('');
    setSuggestions([]);
    setShowSuggestions(false);
    onSelectRoute({ route: route.route, bound: route.bound, company: route.company || 'KMB' });
  };

  useEffect(() => {
    const hide = () => setShowSuggestions(false);
    document.addEventListener('click', hide);
    return () => document.removeEventListener('click', hide);
  }, []);

  return (
    <div className="search-box" onClick={(e) => e.stopPropagation()}>
      <div className="search-input-container">
        <input
          type="text"
          placeholder="Search KMB routes (e.g. '1', '103', '2B', 'Airport')"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyPress={handleKeyPress}
          onFocus={() => query && setShowSuggestions(true)}
        />
        <button
          className="search-button"
          onClick={() => suggestions.length > 0 && handleSelectSuggestion(suggestions[0])}
          disabled={!query.trim()}
          title="Search"
        >
          🔍
        </button>
      </div>

      {showSuggestions && suggestions.length > 0 && (
        <div className="search-suggestions">
          {suggestions.map((route, idx) => (
            <div
              key={`${route.company}-${route.route}-${route.bound}-${idx}`}
              className="search-suggestion-item"
              onClick={() => handleSelectSuggestion(route)}
            >
              <div className="suggestion-text">
                Route {route.route}
                <span style={{
                  fontSize: '0.7rem', marginLeft: '0.4rem', fontWeight: 700,
                  color: '#fff', background: '#2563eb',
                  borderRadius: '4px', padding: '1px 5px'
                }}>KMB</span>
                <span style={{ fontSize: '0.75rem', marginLeft: '0.4rem', color: route.bound === 'O' ? '#3b82f6' : '#f59e0b' }}>
                  {route.bound === 'O' ? 'Outbound' : 'Inbound'}
                </span>
              </div>
              <div className="suggestion-id">{route.name_en}</div>
            </div>
          ))}
        </div>
      )}

      {showSuggestions && query && !loading && suggestions.length === 0 && (
        <div className="search-suggestions">
          <div className="search-suggestion-item" style={{ color: '#999' }}>
            No routes found for "{query}"
          </div>
        </div>
      )}
    </div>
  );
}

export default SearchBar;
