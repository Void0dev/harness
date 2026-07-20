FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/convex-demo/package.json apps/convex-demo/package.json
COPY services/issue-harness/package.json services/issue-harness/package.json
RUN npm ci --workspace @harness/convex-demo --include-workspace-root
COPY apps/convex-demo apps/convex-demo
WORKDIR /app/apps/convex-demo
ARG VITE_CONVEX_URL
RUN test -n "$VITE_CONVEX_URL"
ENV VITE_CONVEX_URL=$VITE_CONVEX_URL
RUN npm run build

FROM nginx:1.29.3-alpine@sha256:b3c656d55d7ad751196f21b7fd2e8d4da9cb430e32f646adcf92441b72f82b14
COPY apps/convex-demo/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/convex-demo/dist /usr/share/nginx/html
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget --quiet --output-document=/dev/null http://127.0.0.1:4173/healthz || exit 1
