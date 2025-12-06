FROM node:alpine

WORKDIR /app

COPY . .

# 暴露端口: 3000(订阅), 8000(Reality/Hy2), 8001(Tuic)
EXPOSE 3000/tcp 8000/tcp 8000/udp 8001/udp

# 安装 openssl (生成证书), tar (解压内核), curl
RUN apk update && \
    apk add --no-cache curl tar bash coreutils openssl && \
    npm install

CMD ["node", "index.js"]
