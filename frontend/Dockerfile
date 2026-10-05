# syntax=docker/dockerfile:1
# Build context: repository root.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --workspace frontend --include-workspace-root=false
COPY shared shared
COPY frontend frontend
ARG VITE_TERMINAL_ID=T1
ENV VITE_TERMINAL_ID=$VITE_TERMINAL_ID
RUN npm -w frontend run build

FROM nginx:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html
EXPOSE 80
