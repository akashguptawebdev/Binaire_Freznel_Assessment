# Multi-stage: build the React dashboard, then run the zero-config Node server.
FROM node:20-alpine AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm install
COPY web/ ./
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev
COPY server/ ./server/
COPY --from=web /app/web/dist ./web/dist
EXPOSE 4000
CMD ["node", "server/src/index.js"]
