# ==========================================
# Socket.IO Server
# ==========================================
FROM node:22-alpine

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

EXPOSE 3001

CMD ["node", "server.js"]
