FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY functions/weather-fetcher/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY functions/weather-fetcher/app.py .

# Health check - verify it can connect to DB
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import psycopg2; psycopg2.connect('host=${POSTGRES_HOST:-postgres-db} dbname=${POSTGRES_DB:-hk_bus} user=${POSTGRES_USER:-postgres} password=${POSTGRES_PASSWORD:-postgres}')" || exit 1

# Run the fetcher
CMD ["python", "-u", "app.py"]
