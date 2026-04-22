import json
import pytest
from unittest.mock import patch, MagicMock
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'functions', 'kmb-fetcher'))

FAKE_STOP_ETA_RESPONSE = {
    "data": [
        {
            "co": "KMB", "route": "1A", "dir": "O", "service_type": "1",
            "seq": 1, "stop": "STOP_AAA", "dest_en": "STAR FERRY",
            "eta_seq": 1, "eta": "2026-04-22T14:32:00+08:00",
            "rmk_en": "", "data_timestamp": "2026-04-22T14:28:00+08:00"
        },
        {
            "co": "KMB", "route": "999X", "dir": "O", "service_type": "1",
            "seq": 1, "stop": "STOP_AAA", "dest_en": "SOMEWHERE",
            "eta_seq": 1, "eta": "2026-04-22T14:33:00+08:00",
            "rmk_en": "", "data_timestamp": "2026-04-22T14:28:00+08:00"
        }
    ]
}

FAKE_CONFIG = {
    "routes": ["1A", "2"],
    "stop_ids": ["STOP_AAA", "STOP_BBB"]
}


def test_fetch_stop_eta_returns_records():
    with patch('handler.requests.get') as mock_get:
        mock_resp = MagicMock()
        mock_resp.json.return_value = FAKE_STOP_ETA_RESPONSE
        mock_resp.raise_for_status = MagicMock()
        mock_get.return_value = mock_resp

        from handler import fetch_stop_eta
        records = fetch_stop_eta("STOP_AAA")

    assert len(records) == 2


def test_filter_records_keeps_only_target_routes():
    with patch('handler.requests.get') as mock_get:
        mock_resp = MagicMock()
        mock_resp.json.return_value = FAKE_STOP_ETA_RESPONSE
        mock_resp.raise_for_status = MagicMock()
        mock_get.return_value = mock_resp

        from handler import fetch_stop_eta, filter_records
        records = fetch_stop_eta("STOP_AAA")
        filtered = filter_records(records, ["1A", "2"])

    assert len(filtered) == 1
    assert filtered[0]["route"] == "1A"


def test_fetch_stop_eta_adds_fetched_at():
    with patch('handler.requests.get') as mock_get:
        mock_resp = MagicMock()
        mock_resp.json.return_value = FAKE_STOP_ETA_RESPONSE
        mock_resp.raise_for_status = MagicMock()
        mock_get.return_value = mock_resp

        from handler import fetch_stop_eta
        records = fetch_stop_eta("STOP_AAA")

    assert all("fetched_at" in r for r in records)


def test_build_kafka_message_structure():
    from handler import build_kafka_message
    record = FAKE_STOP_ETA_RESPONSE["data"][0]
    record["fetched_at"] = "2026-04-22T14:28:01+00:00"
    msg = build_kafka_message(record)
    parsed = json.loads(msg)
    required_keys = ["co", "route", "dir", "service_type", "seq", "stop",
                     "dest_en", "eta_seq", "eta", "rmk_en", "data_timestamp", "fetched_at"]
    for key in required_keys:
        assert key in parsed, f"Missing key: {key}"


def test_handle_publishes_filtered_records_to_kafka():
    with patch('handler.load_config', return_value=FAKE_CONFIG), \
         patch('handler.fetch_stop_eta') as mock_fetch, \
         patch('handler.KafkaProducer') as mock_producer_cls:

        mock_fetch.return_value = FAKE_STOP_ETA_RESPONSE["data"]
        mock_producer = MagicMock()
        mock_producer_cls.return_value = mock_producer

        from handler import handle
        handle("")

    # Two stop IDs → two fetch calls
    assert mock_fetch.call_count == 2
    # Only 1A records pass filter (not 999X) → 2 stops × 1 matching record = 2 sends
    assert mock_producer.send.call_count == 2
