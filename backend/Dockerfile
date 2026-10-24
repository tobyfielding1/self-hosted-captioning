# Built once per venue by `gcloud run deploy --source`. The Node major version here is frozen
# for that venue until they re-run the install, so only bump it deliberately.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run bundle

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/server.mjs ./server.mjs
COPY boot.mjs ./boot.mjs
USER node
CMD ["node", "boot.mjs"]
