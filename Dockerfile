FROM node:22-bookworm-slim

WORKDIR /home

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_OPTIONS=--use-openssl-ca

COPY package*.json ./
RUN npm install
COPY . .

CMD ["node", "server.js"]
