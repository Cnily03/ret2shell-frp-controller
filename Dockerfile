FROM node:24-slim AS prod-deps

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

COPY package.json .
COPY pnpm-lock.yaml .

ARG REGISTRY_URL
RUN if [ -n "$REGISTRY_URL" ]; then pnpm config set registry $REGISTRY_URL; fi

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

FROM oven/bun:1-slim AS bun

FROM keymetrics/pm2:latest-slim

COPY --from=bun /usr/local/bin/bun /usr/bin/bun

WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules

COPY package.json .
COPY tsconfig.json .
COPY src src/
COPY ecosystem.config.* .

ENV NODE_ENV=production

CMD [ "pm2-runtime", "start", "ecosystem.config.cjs" ]

EXPOSE 3000