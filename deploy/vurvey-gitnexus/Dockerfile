FROM node:22-trixie-slim

USER root

COPY --chown=node:node gitnexus-package /app/gitnexus
COPY --chown=node:node .gitnexus-runtime /workspace/.gitnexus-runtime
COPY --chown=node:node server-auth-proxy.mjs /app/server-auth-proxy.mjs

USER node

ENV GITNEXUS_HOME=/workspace/.gitnexus-runtime \
    GITNEXUS_INTERNAL_PORT=4747 \
    NODE_ENV=production \
    PORT=8080

EXPOSE 8080

CMD ["node", "/app/server-auth-proxy.mjs"]
