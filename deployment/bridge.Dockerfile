# Prepared only. Do not build/push/deploy externally without owner approval.
FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node server ./server
USER node
EXPOSE 10000
CMD ["node", "server/demo-server.mjs", "--hosted"]
