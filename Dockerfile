FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production && yarn cache clean

COPY server.js ./

LABEL app=rpl
USER node
EXPOSE 8010

CMD ["node", "server.js"]
