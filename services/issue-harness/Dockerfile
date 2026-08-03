FROM node:22-bookworm@sha256:5647be709086c696ff32edaaf1c70cd26d1da6ab2b39c32f3c7b4c4a31957e37

ARG SOURCE_REPOSITORY
ARG SOURCE_COMMIT
LABEL org.opencontainers.image.source=$SOURCE_REPOSITORY \
      org.opencontainers.image.revision=$SOURCE_COMMIT

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl jq ca-certificates openssh-client \
  && groupadd -g 20001 harness-shared \
  && useradd -m -u 10001 -g 20001 agent \
  && install -d -o agent -g harness-shared -m 0700 \
    /opt/issue-harness/data \
    /opt/issue-harness/data/state \
  && install -d -o agent -g harness-shared -m 2770 \
    /opt/issue-harness/data/context \
    /opt/issue-harness/data/runs \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
COPY services/issue-harness/package.json services/issue-harness/package.json
RUN npm ci --workspace @harness/issue-harness --include-workspace-root

COPY . .
RUN find services/issue-harness -maxdepth 1 -type f -name '*.sh' -exec sed -i 's/\r$//' {} + \
  && npm run build -w services/issue-harness

ENV HARNESS_DATA_DIR=/opt/issue-harness/data \
    HOME=/home/agent \
    NODE_ENV=production
USER agent
EXPOSE 3000 4096
CMD ["bash", "services/issue-harness/start.sh"]
