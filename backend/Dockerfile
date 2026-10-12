FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
COPY assets ./assets
RUN npm run build -- --path tsconfig.docker.json

FROM node:24-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=dependencies --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node docker ./docker
USER node
EXPOSE 3000
CMD ["sh", "-c", "node docker/startup.cjs && exec node dist/src/main.js"]
