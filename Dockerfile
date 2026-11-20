FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV DATABASE_PATH=/var/data/moonwolf.sqlite
RUN mkdir -p /var/data && chown node:node /var/data
COPY --chown=node:node web ./web
COPY --chown=node:node server ./server
COPY --chown=node:node scripts/backup.mjs ./scripts/backup.mjs
COPY --chown=node:node package.json ./package.json
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
