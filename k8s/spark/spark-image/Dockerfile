FROM python:3.11-slim

RUN pip install --no-cache-dir \
    pyspark==3.5.0 \
    psycopg2-binary \
    python-dateutil \
    kafka-python

RUN mkdir -p /opt/spark/jobs
COPY streaming_job.py /opt/spark/jobs/
COPY batch_job.py /opt/spark/jobs/

ENV SPARK_HOME=/usr/local/lib/python3.11/site-packages/pyspark
ENV PATH=$SPARK_HOME/bin:$PATH
