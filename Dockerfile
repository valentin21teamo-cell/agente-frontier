FROM node:22-slim
WORKDIR /app
# OCR para localizar elementos por su texto con precisión de píxel (src/agent/ocr.ts)
RUN apt-get update \
  && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-spa tesseract-ocr-eng \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY tsconfig.json ./
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npx", "tsx", "src/server.ts"]
