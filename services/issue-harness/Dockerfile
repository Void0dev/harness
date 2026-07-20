FROM node:22-bookworm@sha256:5647be709086c696ff32edaaf1c70cd26d1da6ab2b39c32f3c7b4c4a31957e37

ARG SOURCE_REPOSITORY
ARG SOURCE_COMMIT
LABEL org.opencontainers.image.source=$SOURCE_REPOSITORY \
      org.opencontainers.image.revision=$SOURCE_COMMIT

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl jq ca-certificates docker-cli openssh-client gosu \
  && useradd -m -u 10001 agent \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/convex-demo/package.json apps/convex-demo/package.json
COPY services/issue-harness/package.json services/issue-harness/package.json
RUN npm ci --workspace @harness/issue-harness --include-workspace-root

COPY . .
RUN npm run build -w services/issue-harness

ENV HARNESS_DATA_DIR=/opt/issue-harness/default
ENV HOME=/home/agent
CMD ["bash", "services/issue-harness/start.sh"]
