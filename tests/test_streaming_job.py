import pytest
from datetime import datetime, timezone, timedelta
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'spark'))
from streaming_job import compute_wait_seconds, compute_delay_flag, parse_eta_record


def make_record(eta_offset_min=10, data_ts_offset_min=0):
    base = datetime(2026, 4, 22, 14, 0, 0, tzinfo=timezone.utc)
    eta = (base + timedelta(minutes=eta_offset_min)).isoformat()
    data_ts = (base + timedelta(minutes=data_ts_offset_min)).isoformat()
    return {
        "co": "KMB", "route": "1A", "dir": "O",
        "stop": "STOP_AAA", "eta_seq": 1,
        "eta": eta, "rmk_en": "", "data_timestamp": data_ts,
        "fetched_at": data_ts
    }


def test_compute_wait_seconds_returns_correct_value():
    record = make_record(eta_offset_min=10, data_ts_offset_min=0)
    wait = compute_wait_seconds(record["eta"], record["data_timestamp"])
    assert wait == pytest.approx(600.0)


def test_compute_wait_seconds_returns_none_for_null_eta():
    wait = compute_wait_seconds(None, "2026-04-22T14:00:00+00:00")
    assert wait is None


def test_compute_delay_flag_true_above_threshold():
    assert compute_delay_flag(601.0) is True


def test_compute_delay_flag_false_below_threshold():
    assert compute_delay_flag(599.0) is False


def test_compute_delay_flag_false_for_none():
    assert compute_delay_flag(None) is False


def test_parse_eta_record_returns_expected_keys():
    record = make_record()
    parsed = parse_eta_record(record)
    assert parsed["route"] == "1A"
    assert parsed["dir"] == "O"
    assert parsed["wait_sec"] == pytest.approx(600.0)
