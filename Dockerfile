FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --chown=node:node web ./web
COPY --chown=node:node server ./server
COPY --chown=node:node package.json ./package.json
USER node
EXPOSE 3000
CMD ["node", "server/index.mjs"]
