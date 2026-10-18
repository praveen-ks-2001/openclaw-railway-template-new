FROM node:24.16.0-bookworm

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    gosu \
    procps \
    tini \
    python3 \
    build-essential \
    zip \
    unzip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate && pnpm install --frozen-lockfile --prod

RUN useradd -m -s /bin/bash openclaw \
  && chown -R openclaw:openclaw /app \
  && mkdir -p /data && chown openclaw:openclaw /data \
  && mkdir -p /home/linuxbrew/.linuxbrew && chown -R openclaw:openclaw /home/linuxbrew

USER openclaw
RUN NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

ENV PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"
ENV HOMEBREW_PREFIX="/home/linuxbrew/.linuxbrew"
ENV HOMEBREW_CELLAR="/home/linuxbrew/.linuxbrew/Cellar"
ENV HOMEBREW_REPOSITORY="/home/linuxbrew/.linuxbrew/Homebrew"

# entrypoint.sh installs the exact release pinned in this branch's package.json.
# Railway environment variables cannot select a different OpenClaw version.
ENV PORT=8080
ENV OPENCLAW_STATE_DIR=/data/.openclaw
ENV OPENCLAW_WORKSPACE_DIR=/data/workspace
ENV OPENCLAW_SERVICE_REPAIR_POLICY=external
ENV OPENCLAW_ENTRY=/usr/local/lib/node_modules/openclaw/dist/entry.js
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f "http://localhost:${PORT}/setup/healthz" || exit 1

USER root
COPY --chown=openclaw:openclaw src ./src
COPY --chown=openclaw:openclaw scripts ./scripts
COPY --chown=openclaw:openclaw --chmod=755 entrypoint.sh ./entrypoint.sh
ENV OPENCLAW_SUPERVISOR_MODE=external
ENTRYPOINT ["tini", "--", "./entrypoint.sh"]
