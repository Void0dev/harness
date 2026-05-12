FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/convex-demo/package.json apps/convex-demo/package.json
RUN npm install
COPY apps/convex-demo apps/convex-demo
WORKDIR /app/apps/convex-demo
RUN npm run build

FROM node:22-alpine
WORKDIR /app
RUN npm install -g vite@8.0.12
COPY --from=build /app/apps/convex-demo/dist ./dist
EXPOSE 4173
CMD ["vite", "preview", "--host", "0.0.0.0", "--port", "4173"]
