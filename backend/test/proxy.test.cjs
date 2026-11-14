/**
 * Cloudflare Pages 중계 모드 검증. 서버를 운영 모드(NODE_ENV=production)로 이 PC에서 띄우고, 실제 중계 함수 코드
 * (deploy/pages/functions/api/[[path]].js)를 그대로 불러와 요청을 통과시킨다(Cloudflare 계정 없이 확인).
 * 확인 내용: 표식 없는 직접 접속 거절, 중계를 거친 요청의 보안 쿠키, 접속자 IP 전달(로그인 시도 제한 기준),
 * 설정 누락 시 503, Pages 보안 헤더(_headers)와 서버 보안 헤더의 CSP 일치. _test DB에서만 실행한다.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ORIGIN = 'https://doneline-app.pages.dev';
const SECRET = crypto.randomBytes(32).toString('hex');
let app, db, base, relay;

before(async () => {
  if (!process.env.PGDATABASE?.endsWith('_test')) throw Error('Isolated DB required');
  // 설정은 처음 불러올 때 환경변수를 읽으므로 운영 모드 값을 먼저 넣는다(.env보다 우선).
  Object.assign(process.env, {
    NODE_ENV: 'production',
    APP_ORIGIN: ORIGIN,
    TRUST_PROXY: '1',
    HOST: '127.0.0.1',
    PROXY_SECRET: SECRET,
  });
  const { createApp } = require('../dist/app');
  const { Db } = require('../dist/db');
  app = await createApp();
  db = app.get(Db);
  db.useScriptWorkspace(await db.platformWorkspaceId());
  await app.listen(0, '127.0.0.1');
  base = 'http://127.0.0.1:' + app.getHttpServer().address().port;
  // 중계 함수는 Cloudflare용 ESM 파일이라 내용을 그대로 모듈로 불러온다.
  const src = fs.readFileSync(
    path.join(__dirname, '../../deploy/pages/functions/api/[[path]].js'),
    'utf8',
  );
  relay = await import('data:text/javascript,' + encodeURIComponent(src));
  // Node의 fetch는 본문을 흘려보낼 때 duplex 옵션이 필요하다(Cloudflare에서는 불필요). 테스트에서만 보충한다.
  const nodeFetch = globalThis.fetch;
  globalThis.fetch = (url, init = {}) =>
    nodeFetch(url, init.body ? { ...init, duplex: 'half' } : init);
});
after(async () => app?.close());

// 브라우저가 doneline-app.pages.dev에 보낸 요청을 중계 함수로 처리한다. ip는 Cloudflare가 알려 주는 접속자 IP 역할.
const viaPages = (p, { ip = '203.0.113.10', env, ...init } = {}) =>
  relay.onRequest({
    request: new Request(ORIGIN + p, {
      ...init,
      headers: { Origin: ORIGIN, 'CF-Connecting-IP': ip, ...(init.headers || {}) },
    }),
    env: env || { BACKEND_ORIGIN: base, PROXY_SECRET: SECRET },
  });

test('direct requests without the relay mark are rejected', async () => {
  assert.equal((await fetch(base + '/api/auth/csrf')).status, 403);
  const forged = await fetch(base + '/api/auth/csrf', {
    headers: { 'X-Doneline-Proxy': 'wrong', 'X-Doneline-Client-IP': '198.51.100.1' },
  });
  assert.equal(forged.status, 403);
});

test('relay passes requests with a secure session cookie', async () => {
  const res = await viaPages('/api/auth/csrf');
  assert.equal(res.status, 200);
  assert.ok((await res.json()).csrfToken);
  const cookie = res.headers.get('set-cookie') || '';
  assert.match(cookie, /doneline\.sid=/);
  assert.match(cookie, /Secure/);
});

test('login attempt limits use the visitor IP sent by the relay', async () => {
  const ip = '198.51.100.' + crypto.randomInt(2, 250);
  const first = await viaPages('/api/auth/csrf', { ip });
  const cookie = (first.headers.get('set-cookie') || '').split(';')[0];
  const { csrfToken } = await first.json();
  const login = await viaPages('/api/auth/login', {
    ip,
    method: 'POST',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginId: 'no_such_user_' + ip, password: 'wrong password 123' }),
  });
  assert.ok(login.status >= 400 && login.status < 500);
  const bucket = 'ip:' + crypto.createHash('sha256').update(ip).digest('hex');
  const row = (await db.query('SELECT attempts FROM app.login_limits WHERE bucket=$1', [bucket]))
    .rows[0];
  assert.equal(row?.attempts, 1);
});

test('relay without settings answers 503 instead of calling the server', async () => {
  const res = await viaPages('/api/auth/csrf', { env: { BACKEND_ORIGIN: base } });
  assert.equal(res.status, 503);
});

test('Pages security headers match the server CSP', async () => {
  const server = await fetch(base + '/', { headers: { 'X-Doneline-Proxy': SECRET } });
  const file = fs.readFileSync(path.join(__dirname, '../../deploy/pages/_headers'), 'utf8');
  const pages = /Content-Security-Policy: (.+)/.exec(file)[1].trim();
  assert.equal(pages, server.headers.get('content-security-policy'));
});
