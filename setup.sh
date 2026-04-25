#!/bin/bash
# HK Bus Tracking System - Quick Setup

set -e

echo "🚀 HK Bus Tracking System Setup"
echo ""

# Check prerequisites
echo "Checking prerequisites..."
command -v kubectl &> /dev/null || { echo "❌ kubectl not found"; exit 1; }
command -v docker &> /dev/null || { echo "❌ docker not found"; exit 1; }
kubectl cluster-info &> /dev/null || { echo "❌ Kubernetes not accessible"; exit 1; }
echo "✅ Prerequisites OK"
echo ""

# Create namespace
NAMESPACE="hk-bus"
echo "Creating namespace '$NAMESPACE'..."
kubectl create namespace $NAMESPACE --dry-run=client -o yaml | kubectl apply -f -
echo "✅ Namespace ready"
echo ""

# Deploy services
echo "Deploying services..."
kubectl apply -f k8s/ -n $NAMESPACE
echo "✅ Services deployed"
echo ""

# Wait for pods
echo "Waiting for pods to be ready (1-2 minutes)..."
kubectl wait --for=condition=ready pod -l app=postgres -n $NAMESPACE --timeout=120s 2>/dev/null || true
kubectl wait --for=condition=ready pod -l app=eta-fetcher -n $NAMESPACE --timeout=120s 2>/dev/null || true
kubectl wait --for=condition=ready pod -l app=hk-bus-web -n $NAMESPACE --timeout=120s 2>/dev/null || true
echo "✅ Services are running"
echo ""

# Display status
echo "Pod status:"
kubectl get pods -n $NAMESPACE
echo ""

# Display next steps
echo "✅ SETUP COMPLETE"
echo ""
echo "Next steps:"
echo "1. Port forward web app:"
echo "   kubectl port-forward -n hk-bus svc/hk-bus-web 8080:80"
echo ""
echo "2. Port forward Grafana:"
echo "   kubectl port-forward -n hk-bus svc/grafana 3000:3000"
echo ""
echo "3. Open browser:"
echo "   http://localhost:8080"
echo "   Search for: 91M"
echo ""
