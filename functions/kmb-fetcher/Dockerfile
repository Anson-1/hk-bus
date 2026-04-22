FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY handler.py .
COPY stops_config.json .

ENV KAFKA_BROKER=kafka:9092
ENV KAFKA_TOPIC=kmb-eta-raw

CMD ["python", "handler.py"]
