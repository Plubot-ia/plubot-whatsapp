FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

RUN mkdir -p /app/auth-sessions

EXPOSE 3001

CMD ["node", "server.js"]
