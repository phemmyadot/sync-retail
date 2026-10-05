# syntax=docker/dockerfile:1
# Build context: repository root (npm workspaces need the root lockfile).

FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --workspace backend --include-workspace-root=false
COPY shared shared
COPY backend backend
RUN npm -w backend run db:generate && npm -w backend run build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
# Full node_modules: the Prisma CLI (migrations) and tsx (seed) run at startup.
COPY --from=build /app /app
WORKDIR /app/backend
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://localhost:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Apply migrations, seed demo data only if the database is empty, then serve.
CMD ["sh", "-c", "npx prisma migrate deploy && if [ \"$SEED_DEMO_DATA\" = \"true\" ]; then npx tsx prisma/seed.ts --if-empty; fi && node dist/server.js"]
