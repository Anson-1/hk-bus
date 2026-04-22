import json
import pytest
from unittest.mock import patch, MagicMock
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
from bootstrap_stops import fetch_stops_for_route, build_stops_config


FAKE_ROUTE_STOP_RESPONSE = {
    "data": [
        {"co": "KMB", "route": "1A", "bound": "O", "service_type": "1", "seq": 1, "stop": "STOP_AAA"},
        {"co": "KMB", "route": "1A", "bound": "O", "service_type": "1", "seq": 2, "stop": "STOP_BBB"},
    ]
}


def test_fetch_stops_for_route_returns_stop_ids():
    with patch('bootstrap_stops.requests.get') as mock_get:
        mock_response = MagicMock()
        mock_response.json.return_value = FAKE_ROUTE_STOP_RESPONSE
        mock_response.raise_for_status = MagicMock()
        mock_get.return_value = mock_response

        stops = fetch_stops_for_route("1A", "outbound", "1")

    assert stops == ["STOP_AAA", "STOP_BBB"]
    mock_get.assert_called_once_with(
        "https://data.etabus.gov.hk/v1/transport/kmb/route-stop/1A/outbound/1",
        timeout=10
    )


def test_fetch_stops_for_route_handles_empty_data():
    with patch('bootstrap_stops.requests.get') as mock_get:
        mock_response = MagicMock()
        mock_response.json.return_value = {"data": []}
        mock_response.raise_for_status = MagicMock()
        mock_get.return_value = mock_response

        stops = fetch_stops_for_route("1A", "outbound", "1")

    assert stops == []


def test_build_stops_config_deduplicates():
    stops_by_route = {
        "1A": ["STOP_AAA", "STOP_BBB"],
        "2": ["STOP_BBB", "STOP_CCC"],
    }
    config = build_stops_config(["1A", "2"], stops_by_route)
    assert sorted(config["stop_ids"]) == ["STOP_AAA", "STOP_BBB", "STOP_CCC"]
    assert config["routes"] == ["1A", "2"]
