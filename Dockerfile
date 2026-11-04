FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
USER node
ENV PREVIEW_HOST=0.0.0.0
ENV PREVIEW_PORT=4300
EXPOSE 4300
CMD ["node", "src/server.mjs"]
