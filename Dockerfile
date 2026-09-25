FROM node:20-alpine

WORKDIR /app

# 仅复制依赖清单后安装，利用 Docker 层缓存
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# 复制应用代码
COPY server ./server
COPY public ./public

# 数据文件目录（由挂载卷持久化；首次启动自动初始化示例 JSON）
RUN mkdir -p /app/data
ENV DATA_FILE=/app/data/cues.json
ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

# 健康检查：依赖 node 自身发起请求，无需额外工具
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server/index.js"]
