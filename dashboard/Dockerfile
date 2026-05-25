FROM node:22-alpine
WORKDIR /repo/dashboard
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 8787
CMD ["node", "server.js"]
