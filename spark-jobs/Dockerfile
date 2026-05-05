FROM python:3.11-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends default-jre-headless curl && \
    rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir pyspark==3.5.1

RUN mkdir -p /opt/spark-jobs

# PostgreSQL JDBC driver
RUN curl -fsSL -o /opt/spark-jobs/postgresql.jar \
    https://jdbc.postgresql.org/download/postgresql-42.7.3.jar

COPY kmb_analysis.py /opt/spark-jobs/kmb_analysis.py

CMD ["spark-submit", \
     "--master", "local[*]", \
     "--driver-memory", "2g", \
     "--jars", "/opt/spark-jobs/postgresql.jar", \
     "/opt/spark-jobs/kmb_analysis.py"]
