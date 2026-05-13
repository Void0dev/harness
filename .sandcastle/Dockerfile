FROM node:22-bookworm

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
