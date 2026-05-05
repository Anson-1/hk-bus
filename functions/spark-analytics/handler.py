"""
spark-analytics — OpenFaaS function
Submits the KMB PySpark analysis job as a Kubernetes Job.
Maps to: AWS Lambda triggering EMR/Glue.
"""

import json
import uuid
from flask import Flask, jsonify
from kubernetes import client, config

app = Flask(__name__)

SPARK_IMAGE     = "hk-bus-spark:local"
JOB_NAMESPACE   = "hk-bus"
JOB_TTL_SECONDS = 3600   # auto-clean completed jobs after 1h


def build_job(job_name: str) -> client.V1Job:
    return client.V1Job(
        metadata=client.V1ObjectMeta(
            name=job_name,
            namespace=JOB_NAMESPACE,
            labels={"app": "spark-analytics"},
        ),
        spec=client.V1JobSpec(
            ttl_seconds_after_finished=JOB_TTL_SECONDS,
            backoff_limit=1,
            template=client.V1PodTemplateSpec(
                metadata=client.V1ObjectMeta(labels={"app": "spark-analytics"}),
                spec=client.V1PodSpec(
                    restart_policy="Never",
                    containers=[
                        client.V1Container(
                            name="spark-analysis",
                            image=SPARK_IMAGE,
                            image_pull_policy="Never",
                            command=[
                                "spark-submit",
                                "--master",        "local[*]",
                                "--driver-memory", "2g",
                                "--jars",          "/opt/spark-jobs/postgresql.jar",
                                "/opt/spark-jobs/kmb_analysis.py",
                            ],
                            env=[
                                client.V1EnvVar(
                                    name="DB_PASSWORD",
                                    value_from=client.V1EnvVarSource(
                                        secret_key_ref=client.V1SecretKeySelector(
                                            name="postgres-secret",
                                            key="password",
                                        )
                                    ),
                                )
                            ],
                            resources=client.V1ResourceRequirements(
                                requests={"memory": "2Gi", "cpu": "500m"},
                                limits={"memory": "3Gi"},
                            ),
                        )
                    ],
                ),
            ),
        ),
    )


@app.post("/")
def handle():
    try:
        config.load_incluster_config()
        batch_v1 = client.BatchV1Api()
        job_name = f"kmb-analysis-{uuid.uuid4().hex[:8]}"
        job = build_job(job_name)
        batch_v1.create_namespaced_job(namespace=JOB_NAMESPACE, body=job)
        return jsonify({"status": "submitted", "job": job_name})
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


@app.get("/healthz")
def healthz():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
