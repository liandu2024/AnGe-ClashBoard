# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM docker.io/node:22-alpine AS builder

WORKDIR /build

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack pnpm install --frozen-lockfile --ignore-scripts

COPY . .
RUN pnpm build

FROM docker.io/node:22-alpine

ARG TARGETARCH
ARG TARGETVARIANT

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack pnpm install --prod --frozen-lockfile --ignore-scripts

COPY scripts/fetch-mihomo.mjs ./scripts/fetch-mihomo.mjs
RUN TARGETARCH="${TARGETARCH}" TARGETVARIANT="${TARGETVARIANT}" node ./scripts/fetch-mihomo.mjs \
  && chmod +x .tools/mihomo-bin/mihomo \
  && rm -rf ./scripts

COPY --from=builder /build/dist ./dist
COPY config ./config
COPY server ./server

ENV PORT=2048

EXPOSE 2048

CMD ["node", "server/index.mjs"]
