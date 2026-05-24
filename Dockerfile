FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/download-model.mjs ./scripts/

RUN npx tsc
RUN node scripts/download-model.mjs

# Run as non-root user for security
RUN addgroup --system app && adduser --system --ingroup app app
RUN chown -R app:app /app
USER app

EXPOSE 3000

CMD ["node", "dist/server/index.js"]
