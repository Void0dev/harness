FROM node:22-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl jq ca-certificates openssh-client \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @openai/codex@0.130.0

RUN useradd -m -u 1000 agent
USER agent
WORKDIR /repo

ENV HOME=/home/agent
