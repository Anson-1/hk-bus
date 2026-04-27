#!/bin/sh
# Run weather fetcher and ETA collector in parallel
python -u app.py &
python -u eta_collector.py &
wait
