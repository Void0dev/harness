FROM node:22-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl jq ca-certificates docker-cli openssh-client \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
COPY services/issue-harness/package.json services/issue-harness/package.json
RUN npm install

COPY . .
RUN npm run build -w services/issue-harness

ENV HARNESS_DATA_DIR=/data
CMD ["bash", "services/issue-harness/start.sh"]
