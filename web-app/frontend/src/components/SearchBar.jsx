import React, { useState, useCallback, useEffect } from 'react';
import axios from 'axios';

function SearchBar({ onSelectRoute }) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [loading, setLoading] = useState(false);

  const API_BASE = '/api';

  // Focus on Route 91M only for HKUST testing
  const COMMON_ROUTES = ['91M'];

  const handleSearch = useCallback(async (searchQuery) => {
    if (searchQuery.length < 1) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    setLoading(true);
    try {
      const response = await axios.get(`${API_BASE}/route-search`, {
        params: { q: searchQuery }
      });
      setSuggestions(response.data.results);
      setShowSuggestions(true);
    } catch (error) {
      console.error('Search error:', error);
      // Show common routes as fallback
      const filtered = COMMON_ROUTES.filter(r => r.includes(searchQuery.toUpperCase()));
      setSuggestions(filtered.map(r => ({ route: r, name_en: `Route ${r}` })));
      setShowSuggestions(true);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleInputChange = (e) => {
    const value = e.target.value;
    setQuery(value);
    // Auto-search as user types
    handleSearch(value);
  };

  const handleSearchButtonClick = () => {
    if (query.trim()) {
      // For 91M, auto-select immediately
      if (query.trim().toUpperCase() === '91M') {
        onSelectRoute('91M');
        setQuery('');
        setShowSuggestions(false);
      } else {
        handleSearch(query.trim());
      }
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter') {
      handleSearchButtonClick();
    }
  };

  const handleSelectSuggestion = (route) => {
    setQuery('');
    setSuggestions([]);
    setShowSuggestions(false);
    onSelectRoute(route.route);
  };

  useEffect(() => {
    const handleClickOutside = () => {
      setShowSuggestions(false);
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  return (
    <div className="search-box" onClick={(e) => e.stopPropagation()}>
      <div className="search-input-container">
        <input
          type="text"
          placeholder="Search route (e.g., '1', '103', '2B')"
          value={query}
          onChange={handleInputChange}
          onKeyPress={handleKeyPress}
          onFocus={() => setShowSuggestions(true)}
        />
        <button 
          className="search-button"
          onClick={handleSearchButtonClick}
          disabled={!query.trim()}
          title="Search"
        >
          🔍
        </button>
      </div>
      {showSuggestions && suggestions.length > 0 && (
        <div className="search-suggestions">
          {suggestions.map((route) => (
            <div
              key={route.route}
              className="search-suggestion-item"
              onClick={() => handleSelectSuggestion(route)}
            >
              <div className="suggestion-text">
                Route {route.route}
              </div>
              <div className="suggestion-id">
                {route.name_en || 'Bus Route'}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default SearchBar;
