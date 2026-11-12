# Doneline 실행 이미지. 서버(NestJS)와 화면(React 빌드 결과)을 한 컨테이너로 제공한다.
# 1단계(build)에서 의존성 설치·빌드를 하고, 2단계에는 실행에 필요한 파일만 담아 이미지를 작게 유지한다.
# DB는 컨테이너 밖의 관리형 PostgreSQL을 쓰며, 마이그레이션(database/*.sql)은 배포 전에 관리 계정으로 적용한다.
# 필요한 환경변수: PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD SESSION_SECRET APP_ORIGIN(https)
#   선택: SLACK_WEBHOOK_URL, TRUST_PROXY(앞단 프록시 수)+PROXY_ONLY_INGRESS=1(로드밸런서 경유만 가능할 때)
# bookworm-slim(glibc)을 쓰는 이유: 비밀번호 해시 모듈 argon2의 미리 빌드된 바이너리를 그대로 쓰기 위해서.
FROM node:22-bookworm-slim AS build
WORKDIR /app
# 잠금 파일만 먼저 복사해 소스가 바뀌어도 의존성 설치 단계는 캐시를 재사용한다.
COPY backend/package.json backend/package-lock.json backend/
COPY frontend/package.json frontend/package-lock.json frontend/
RUN npm ci --prefix backend && npm ci --include=dev --prefix frontend
COPY backend backend
COPY frontend frontend
RUN npm run build --prefix backend \
  && npm run build --prefix frontend \
  && npm prune --omit=dev --prefix backend

FROM node:22-bookworm-slim
# HOST=0.0.0.0: 컨테이너 밖(로드밸런서)에서 접속할 수 있게 모든 주소에서 연다.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3100
WORKDIR /app
COPY --from=build /app/backend/package.json backend/
COPY --from=build /app/backend/node_modules backend/node_modules
COPY --from=build /app/backend/dist backend/dist
COPY --from=build /app/frontend/dist frontend/dist
COPY database database
# runtime: DB 장애 시 감사 기록 대체 파일을 쓰는 폴더. 권한 없는 node 사용자로 실행하므로 미리 소유권을 준다.
RUN mkdir runtime && chown node:node runtime
USER node
EXPOSE 3100
CMD ["node", "backend/dist/main.js"]
