# The remote MCP connector.
#
# Deliberately boring: this package has no build step and one runtime
# dependency, so there is nothing to compile and nothing to copy between
# stages. ezmodo's Dockerfile builds from its repo ROOT because its server is
# an npm workspace and `npm ci` without the root lockfile floats every
# dependency — this package is standalone, so the context is just the package.
FROM node:22-alpine

WORKDIR /app

# Dependencies first, so a source change does not re-resolve them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# Not root. Cloud Run will not stop you, which is exactly why it is worth doing.
USER node

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# `node`, NOT `npm start`. npm forwards no signals, so SIGTERM would never
# reach the process — and every scale-down would kill in-flight tool calls
# rather than draining them.
CMD ["node", "src/http.js"]
