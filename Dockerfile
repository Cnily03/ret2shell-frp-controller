FROM node:24-slim AS prod-deps

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

COPY package.json .
COPY pnpm-lock.yaml .

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

EXPOSE 3000

CMD [ "pm2-runtime", "start", "ecosystem.config.cjs" ]