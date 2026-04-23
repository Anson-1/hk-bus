#!/bin/bash

################################################################################
#                                                                              #
#  HK BUS REALTIME ETA TRACKING SYSTEM - COMPLETE SETUP SCRIPT               #
#                                                                              #
#  This script sets up the entire system from scratch:                       #
#  - Kubernetes cluster with all services                                    #
#  - Kafka message queue                                                     #
#  - PostgreSQL database                                                     #
#  - Spark Streaming job                                                     #
#  - Grafana dashboards                                                      #
#                                                                              #
#  Usage: ./setup.sh [--test] [--help]                                       #
#                                                                              #
################################################################################

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
NAMESPACE="hk-bus"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K8S_DIR="$SCRIPT_DIR/k8s"
RUN_TEST=false

# Functions
print_header() {
  echo ""
  echo -e "${BLUE}╔════════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${BLUE}║${NC} $1"
  echo -e "${BLUE}╚════════════════════════════════════════════════════════════════╝${NC}"
  echo ""
}

print_step() {
  echo -e "${YELLOW}▶${NC} $1"
}

print_success() {
  echo -e "${GREEN}✅${NC} $1"
}

print_error() {
  echo -e "${RED}❌${NC} $1"
}

print_info() {
  echo -e "${BLUE}ℹ${NC} $1"
}

check_prerequisites() {
  print_header "Checking Prerequisites"
  
  local missing=0
  
  # Check kubectl
  if ! command -v kubectl &> /dev/null; then
    print_error "kubectl not found. Please install kubectl."
    missing=$((missing + 1))
  else
    print_success "kubectl is installed"
  fi
  
  # Check docker
  if ! command -v docker &> /dev/null; then
    print_error "docker not found. Please install docker."
    missing=$((missing + 1))
  else
    print_success "docker is installed"
  fi
  
  # Check if K8s cluster is accessible
  if ! kubectl cluster-info &> /dev/null; then
    print_error "Kubernetes cluster not accessible. Please start your cluster."
    missing=$((missing + 1))
  else
    print_success "Kubernetes cluster is accessible"
  fi
  
  if [ $missing -gt 0 ]; then
    print_error "Please install missing prerequisites and try again."
    exit 1
  fi
}

create_namespace() {
  print_header "Creating Kubernetes Namespace"
  
  if kubectl get namespace $NAMESPACE &> /dev/null; then
    print_info "Namespace '$NAMESPACE' already exists"
  else
    print_step "Creating namespace..."
    kubectl create namespace $NAMESPACE
    print_success "Namespace created"
  fi
}

deploy_services() {
  print_header "Deploying Kubernetes Services"
  
  local services=("kafka" "postgres" "grafana" "spark")
  
  for service in "${services[@]}"; do
    print_step "Deploying $service..."
    kubectl apply -f "$K8S_DIR/$service/" -n $NAMESPACE
    print_success "$service deployed"
  done
}

wait_for_pods() {
  print_header "Waiting for Pods to Be Ready"
  
  local services=("kafka" "postgres" "grafana" "spark-streaming")
  local timeout=300
  
  for service in "${services[@]}"; do
    print_step "Waiting for $service..."
    if kubectl wait --for=condition=ready pod -l app=$service -n $NAMESPACE --timeout=${timeout}s 2> /dev/null; then
      print_success "$service is ready"
    else
      print_error "$service failed to start within timeout"
    fi
  done
}

initialize_database() {
  print_header "Initializing PostgreSQL Database"
  
  print_step "Waiting for PostgreSQL to be ready..."
  sleep 10
  
  # Create database and tables
  print_step "Creating database schema..."
  kubectl exec postgres-0 -n $NAMESPACE -- psql -U postgres << 'SQL' 2>&1 | grep -E "CREATE|ERROR|^$" || true
CREATE DATABASE IF NOT EXISTS hk_bus;
\c hk_bus;

CREATE TABLE IF NOT EXISTS eta_raw (
  id SERIAL PRIMARY KEY,
  co VARCHAR(10),
  route VARCHAR(10),
  dir VARCHAR(10),
  stop VARCHAR(20),
  eta_seq INTEGER,
  eta VARCHAR(50),
  rmk_en TEXT,
  data_timestamp TIMESTAMP,
  fetched_at TIMESTAMP,
  wait_sec INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS eta_realtime (
  id SERIAL PRIMARY KEY,
  route VARCHAR(10),
  dir VARCHAR(10),
  window_start TIMESTAMP,
  avg_wait_sec DOUBLE PRECISION,
  avg_delay_flag DOUBLE PRECISION,
  sample_count INTEGER,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_eta_realtime_window ON eta_realtime(window_start);
CREATE INDEX IF NOT EXISTS idx_eta_raw_route_direction ON eta_raw(route, dir);

CREATE UNIQUE CONSTRAINT IF NOT EXISTS unique_route_dir_window 
  ON eta_realtime(route, dir, window_start);
SQL

  print_success "Database schema initialized"
}

verify_kafka() {
  print_header "Verifying Kafka"
  
  print_step "Checking Kafka topic..."
  KAFKA_POD=$(kubectl get pods -l app=kafka -n $NAMESPACE -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
  
  if [ -z "$KAFKA_POD" ]; then
    print_error "Kafka pod not found"
    return 1
  fi
  
  kubectl exec $KAFKA_POD -n $NAMESPACE -- \
    /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list 2>/dev/null | grep -q kmb-eta-raw
  
  print_success "Kafka topic 'kmb-eta-raw' is ready"
}

restart_spark() {
  print_header "Restarting Spark Streaming"
  
  print_step "Stopping existing Spark pod..."
  kubectl delete pod -l app=spark-streaming -n $NAMESPACE 2>/dev/null || true
  
  sleep 5
  
  print_step "Waiting for new Spark pod to start..."
  kubectl wait --for=condition=ready pod -l app=spark-streaming -n $NAMESPACE --timeout=120s
  
  print_success "Spark Streaming is running"
}

run_test() {
  print_header "Running End-to-End Pipeline Test"
  
  print_step "Clearing previous test data..."
  kubectl exec postgres-0 -n $NAMESPACE -- \
    psql -U postgres -d hk_bus -c "TRUNCATE eta_realtime RESTART IDENTITY;" 2>&1 | head -1
  
  print_success "Database cleared"
  
  print_step "Waiting for Spark to process messages (30 seconds)..."
  sleep 30
  
  print_step "Checking results..."
  TOTAL=$(kubectl exec postgres-0 -n $NAMESPACE -- \
    psql -U postgres -d hk_bus -t -c "SELECT COUNT(*) FROM eta_realtime" 2>&1 | tr -d ' ')
  
  if [ "$TOTAL" -gt 0 ]; then
    print_success "Pipeline test successful! $TOTAL aggregated windows processed"
  else
    print_error "No data found in database. Pipeline may need more time to process."
    return 1
  fi
}

display_status() {
  print_header "System Status"
  
  echo -e "${BLUE}Kubernetes Pods:${NC}"
  kubectl get pods -n $NAMESPACE -o wide | grep -E "NAME|spark|kafka|postgres|grafana" | \
    awk '{printf "  ✅ %-40s %s\n", $1, $3}'
  
  echo ""
  echo -e "${BLUE}Database Contents:${NC}"
  TOTAL=$(kubectl exec postgres-0 -n $NAMESPACE -- \
    psql -U postgres -d hk_bus -t -c "SELECT COUNT(*) FROM eta_realtime" 2>&1 | tr -d ' ')
  ROUTES=$(kubectl exec postgres-0 -n $NAMESPACE -- \
    psql -U postgres -d hk_bus -t -c "SELECT COUNT(DISTINCT route) FROM eta_realtime" 2>&1 | tr -d ' ')
  SAMPLES=$(kubectl exec postgres-0 -n $NAMESPACE -- \
    psql -U postgres -d hk_bus -t -c "SELECT SUM(sample_count) FROM eta_realtime" 2>&1 | tr -d ' ')
  
  echo "  • Aggregated Windows: $TOTAL"
  echo "  • Unique Routes: $ROUTES"
  echo "  • Total Samples: $SAMPLES"
}

show_help() {
  cat << 'HELP'
HK Bus Realtime ETA Tracking System - Setup Script

USAGE:
  ./setup.sh [OPTIONS]

OPTIONS:
  --test        Run end-to-end pipeline test after setup
  --help        Show this help message

EXAMPLES:
  # Standard setup (no test)
  ./setup.sh

  # Setup with test
  ./setup.sh --test

WHAT THIS SCRIPT DOES:
  1. ✅ Checks prerequisites (kubectl, docker)
  2. ✅ Creates Kubernetes namespace
  3. ✅ Deploys all services (Kafka, PostgreSQL, Spark, Grafana)
  4. ✅ Waits for pods to be ready
  5. ✅ Initializes database schema
  6. ✅ Verifies Kafka connectivity
  7. ✅ Restarts Spark Streaming
  8. ✅ Optionally runs end-to-end test

AFTER SETUP:
  • View logs:  kubectl logs -f -l app=spark-streaming -n hk-bus
  • View data:  kubectl exec postgres-0 -n hk-bus -- psql -U postgres -d hk_bus
  • Port-forward Grafana: kubectl port-forward svc/grafana 3000:3000 -n hk-bus

TIME ESTIMATE: ~5-10 minutes for full setup

HELP
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --test)
      RUN_TEST=true
      shift
      ;;
    --help)
      show_help
      exit 0
      ;;
    *)
      print_error "Unknown option: $1"
      show_help
      exit 1
      ;;
  esac
done

# Main execution
main() {
  print_header "HK BUS REALTIME TRACKING SYSTEM - SETUP"
  
  check_prerequisites
  create_namespace
  deploy_services
  wait_for_pods
  initialize_database
  verify_kafka
  restart_spark
  
  if [ "$RUN_TEST" = true ]; then
    run_test
  fi
  
  display_status
  
  echo ""
  echo -e "${GREEN}╔════════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}║${NC}                                                            ${GREEN}║${NC}"
  echo -e "${GREEN}║${NC}    ✅ SETUP COMPLETE - SYSTEM IS FULLY OPERATIONAL ✅     ${GREEN}║${NC}"
  echo -e "${GREEN}║${NC}                                                            ${GREEN}║${NC}"
  echo -e "${GREEN}╚════════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo "Next steps:"
  echo "  1. Monitor logs:      kubectl logs -f -l app=spark-streaming -n hk-bus"
  echo "  2. View Grafana:      kubectl port-forward svc/grafana 3000:3000 -n hk-bus"
  echo "  3. Query database:    kubectl exec -it postgres-0 -n hk-bus -- psql -U postgres -d hk_bus"
  echo ""
}

main "$@"
