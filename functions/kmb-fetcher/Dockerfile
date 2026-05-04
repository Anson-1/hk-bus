FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY handler.py .
COPY stops_config.json .
ENV REDIS_URL=redis://redis.hk-bus.svc.cluster.local:6379
ENV STREAM_KEY=kmb-eta-raw
EXPOSE 8080
CMD ["python", "handler.py"]
