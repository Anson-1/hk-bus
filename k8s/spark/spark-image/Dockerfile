FROM apache/spark-py:3.5.0

USER root
RUN pip install psycopg2-binary python-dateutil kafka-python

RUN mkdir -p /opt/spark/jobs
COPY streaming_job.py /opt/spark/jobs/
COPY batch_job.py /opt/spark/jobs/

USER 185
