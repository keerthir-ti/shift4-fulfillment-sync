# One image for the app, simulators and worker. compose.yaml chooses what each container runs.
FROM node:22.21.1-bookworm-slim

ENV NEXT_TELEMETRY_DISABLED=1
ENV COREPACK_HOME=/home/node/.corepack

RUN corepack enable && mkdir /app && chown node:node /app
WORKDIR /app
USER node
RUN corepack prepare pnpm@9.15.9 --activate

# Manifests first, so a code change doesn't reinstall dependencies.
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node apps/web/package.json apps/web/
COPY --chown=node:node apps/worker/package.json apps/worker/
COPY --chown=node:node packages/contracts/package.json packages/contracts/
COPY --chown=node:node packages/order-delivery/package.json packages/order-delivery/
COPY --chown=node:node services/sim/package.json services/sim/
RUN pnpm install --frozen-lockfile

COPY --chown=node:node . .

# Named volumes take their ownership from these folders.
RUN mkdir -p .local/oracle .local/foundry .local/connector

EXPOSE 3000 4010 4020 4030 4040
