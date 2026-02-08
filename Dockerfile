FROM node:19

WORKDIR /home
COPY . .
RUN npm install

CMD ["node", "server.js"]