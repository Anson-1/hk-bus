FROM bitnami/spark:3.5

USER root
RUN pip install psycopg2-binary python-dateutil kafka-python

COPY streaming_job.py /opt/bitnami/spark/jobs/
COPY batch_job.py /opt/bitnami/spark/jobs/

USER 1001
