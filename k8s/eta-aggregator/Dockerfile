FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY server.js .

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const http = require('http'); http.get('http://localhost:3003/health', (r) => { if (r.statusCode === 200) process.exit(0); process.exit(1); })"

CMD ["node", "server.js"]
