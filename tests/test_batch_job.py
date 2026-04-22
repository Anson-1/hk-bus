import pytest
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'spark'))
from batch_job import compute_p95, build_analytics_row


def test_compute_p95_correct():
    values = list(range(1, 101))  # 1..100
    assert compute_p95(values) == pytest.approx(95.05, rel=0.01)


def test_compute_p95_single_value():
    assert compute_p95([300.0]) == pytest.approx(300.0)


def test_compute_p95_empty_returns_none():
    assert compute_p95([]) is None


def test_build_analytics_row_structure():
    row = build_analytics_row("1A", 8, 1, [120.0, 180.0, 300.0])
    assert row["route"] == "1A"
    assert row["hour_of_day"] == 8
    assert row["day_of_week"] == 1
    assert row["avg_wait_sec"] == pytest.approx(200.0)
    assert "p95_wait_sec" in row
    assert "computed_at" in row
