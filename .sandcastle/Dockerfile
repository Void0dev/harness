FROM node:22-bookworm@sha256:5647be709086c696ff32edaaf1c70cd26d1da6ab2b39c32f3c7b4c4a31957e37

ARG SOURCE_REPOSITORY
ARG SOURCE_COMMIT
LABEL org.opencontainers.image.source=$SOURCE_REPOSITORY \
      org.opencontainers.image.revision=$SOURCE_COMMIT

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl jq ca-certificates openssh-client \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @openai/codex@0.130.0

RUN useradd -m -u 10001 agent
USER agent
WORKDIR /repo

ENV HOME=/home/agent
ENV GIT_CONFIG_GLOBAL=/tmp/agent.gitconfig

CMD ["sleep", "infinity"]
