FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY public ./public
COPY src ./src

EXPOSE 3000

ENV NODE_ENV=production

VOLUME /app/data

CMD ["node", "src/server.js"]
