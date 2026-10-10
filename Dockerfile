FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY tsconfig.json ./
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npx", "tsx", "src/server.ts"]
