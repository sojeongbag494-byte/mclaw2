# MCLAW backend - Node.js + 개발 도구 포함
FROM node:22-slim

# AI 에이전트가 워크스페이스에서 사용할 도구들
RUN apt-get update && apt-get install -y \
    zip unzip \
    python3 python3-pip \
    git curl wget \
    grep sed gawk \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 의존성 먼저 (레이어 캐시)
COPY package.json ./
RUN npm install --production

# 앱 코드
COPY server.js ./
COPY mclaw.html ./

# 워크스페이스 루트
RUN mkdir -p /tmp/mclaw_workspaces && chmod 777 /tmp/mclaw_workspaces

ENV NODE_ENV=production
ENV WORKSPACE_ROOT=/tmp/mclaw_workspaces

EXPOSE 3000
CMD ["node", "server.js"]
