FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY handler.js .
ENV DB_HOST=postgres-db.hk-bus.svc.cluster.local
EXPOSE 8080
CMD ["node", "handler.js"]
