FROM node:alpine

WORKDIR /app

COPY . .

EXPOSE 3000/tcp 8000/tcp

# 确保安装 tar (用于解压 Sing-box) 和 curl
RUN apk update && \
    apk add --no-cache curl tar bash coreutils && \
    npm install

CMD ["node", "index.js"]
