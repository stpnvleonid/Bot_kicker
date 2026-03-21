# Сборка приложения (образ без .env / secrets / data — они монтируются при запуске)
FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
RUN npm run build

# Рантайм: только production-зависимости + dist + migrations
FROM node:20-bookworm-slim AS runner
WORKDIR /app

# better-sqlite3 собирается из нативных исходников
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && apt-get purge -y python3 make g++ \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations

# Пустые каталоги для монтирования томов (если том не смонтирован — не упадёт на mkdir)
RUN mkdir -p /app/data /app/secrets

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
