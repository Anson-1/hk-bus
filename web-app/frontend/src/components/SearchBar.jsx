import React, { useState, useCallback, useEffect } from 'react';
import axios from 'axios';

function SearchBar({ onSelectStop }) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [loading, setLoading] = useState(false);

  const API_BASE = '/api';

  const handleSearch = useCallback(async (searchQuery) => {
    if (searchQuery.length < 1) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    setLoading(true);
    try {
      const response = await axios.get(`${API_BASE}/search`, {
        params: { q: searchQuery }
      });
      setSuggestions(response.data.results);
      setShowSuggestions(true);
    } catch (error) {
      console.error('Search error:', error);
      setSuggestions([]);
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
      handleSearch(query.trim());
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter') {
      handleSearchButtonClick();
    }
  };

  const handleSelectSuggestion = (stop) => {
    setQuery('');
    setSuggestions([]);
    setShowSuggestions(false);
    onSelectStop(stop.stop_id);
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
          placeholder="Search bus stop by ID or name (e.g., '001' or 'Central')"
          value={query}
          onChange={handleInputChange}
          onKeyPress={handleKeyPress}
          onFocus={() => query && setShowSuggestions(true)}
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
          {suggestions.map((stop) => (
            <div
              key={stop.stop_id}
              className="search-suggestion-item"
              onClick={() => handleSelectSuggestion(stop)}
            >
              <div className="suggestion-text">
                {stop.name_tc || stop.name_en}
              </div>
              <div className="suggestion-id">
                Stop ID: {stop.stop_id}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default SearchBar;
