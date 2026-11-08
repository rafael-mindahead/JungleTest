FROM oven/bun:1.4.4 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.4.4
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json mikro-orm.config.ts ./
COPY src ./src
COPY scripts/setup-sqs.ts ./scripts/setup-sqs.ts
USER bun
EXPOSE 3000
CMD ["bun", "src/main.ts"]
