FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY eta_collector.py .
COPY start.sh .
RUN chmod +x start.sh

CMD ["sh", "start.sh"]
