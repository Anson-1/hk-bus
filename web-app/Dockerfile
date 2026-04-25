# Multi-stage build: First build frontend, then run backend with frontend assets

# Stage 1: Build frontend
FROM node:18-alpine AS frontend-builder

WORKDIR /frontend

COPY web-app/frontend/package*.json ./
RUN npm install

COPY web-app/frontend ./
RUN npm run build

# Stage 2: Build backend with frontend assets
FROM node:18-alpine

WORKDIR /app

# Copy backend dependencies
COPY web-app/backend/package*.json ./
RUN npm install --production

# Copy backend source
COPY web-app/backend/server.js .

# Copy frontend build artifacts from stage 1
COPY --from=frontend-builder /frontend/dist ./public

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Start application
CMD ["npm", "start"]
