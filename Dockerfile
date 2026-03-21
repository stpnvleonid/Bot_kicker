# Сборка приложения (образ без .env / secrets / data — они монтируются при запуске)
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# Медленный registry: увеличить таймаут (одна точка скачивания npm в образе)
ENV NPM_CONFIG_FETCH_TIMEOUT=300000

COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
RUN npm run build \
  && npm prune --omit=dev

# Рантайм: копируем node_modules из builder (без второго npm ci — нет обрывов сети на шаге runner)
FROM node:20-bookworm-slim AS runner
WORKDIR /app

COPY package.json package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations

# Пустые каталоги для монтирования томов (если том не смонтирован — не упадёт на mkdir)
RUN mkdir -p /app/data /app/secrets

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
