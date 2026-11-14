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
const ORIGIN = 'https://doneline.pages.dev';
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

// 브라우저가 doneline.pages.dev에 보낸 요청을 중계 함수로 처리한다. ip는 Cloudflare가 알려 주는 접속자 IP 역할.
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

test('file upload and binary download pass through the relay unchanged', async () => {
  const argon2 = require('argon2');
  const tag = 'px' + crypto.randomBytes(3).toString('hex');
  const password = 'Relay test password 123!';
  const ws = String(
    (await db.query('SELECT app.create_workspace($1,$2) AS id', [tag, tag])).rows[0].id,
  );
  // 고객사·법인·부서와 그 부서에 매핑된 고객사 직원 한 명을 만든다.
  await db.tx(async (c) => {
    const customer = (
      await c.query('INSERT INTO app.customers(code,name) VALUES($1,$1) RETURNING id', [tag])
    ).rows[0].id;
    const corp = (
      await c.query(
        "INSERT INTO app.corporations(customer_id,code,name) VALUES($1,'C1','C1') RETURNING id",
        [customer],
      )
    ).rows[0].id;
    const dept = (
      await c.query(
        "INSERT INTO app.departments(customer_id,corporation_id,code,name) VALUES($1,$2,'D1','D1') RETURNING id",
        [customer, corp],
      )
    ).rows[0].id;
    const resp = (await c.query("SELECT id FROM app.responsibilities WHERE code='CUSTOMER_USER'"))
      .rows[0].id;
    const user = (
      await c.query(
        'INSERT INTO app.users(login_id,password_hash,display_name,resp_id,must_change_password,customer_id) VALUES($1,$2,$1,$3,false,$4) RETURNING id',
        [tag + '_c', await argon2.hash(password), resp, customer],
      )
    ).rows[0].id;
    await c.query(
      'INSERT INTO app.user_corporations(customer_id,user_id,corporation_id) VALUES($1,$2,$3)',
      [customer, user, corp],
    );
    await c.query(
      'INSERT INTO app.user_scopes(customer_id,user_id,corporation_id,department_id) VALUES($1,$2,$3,$4)',
      [customer, user, corp, dept],
    );
  }, ws);
  // 브라우저처럼 쿠키·CSRF 토큰을 이어 가며 중계 함수로만 요청한다.
  let cookie = '';
  let csrf = '';
  const send = async (p, init = {}) => {
    const res = await viaPages(p, {
      ...init,
      headers: { Cookie: cookie, 'X-CSRF-Token': csrf, ...(init.headers || {}) },
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return res;
  };
  csrf = (await (await send('/api/auth/csrf')).json()).csrfToken;
  const login = await send('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Menu-ID': '0' },
    body: JSON.stringify({ loginId: tag + '_c', password }),
  });
  assert.equal(login.status, 201);
  csrf = (await login.json()).csrfToken || csrf;
  const nav = await (await send('/api/navigation')).json();
  const menu = nav.screens.find((s) => s.code === 'SR_PORTAL').menu_id;
  const scope = (
    await (await send('/api/requests/portal', { headers: { 'X-Menu-ID': menu } })).json()
  ).scopes[0];
  const created = await send('/api/requests/portal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Menu-ID': menu },
    body: JSON.stringify({
      title: '중계 첨부',
      body: '본문',
      category: 'REQUEST',
      priority: 'LOW',
      corporationId: String(scope.corporation_id),
      departmentId: String(scope.department_id),
    }),
  });
  const id = (await created.json()).id;
  // 이진 파일(0~255 모든 바이트)을 multipart로 올리고, 받은 바이트가 그대로인지 비교한다.
  const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256));
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'image/png' }), '중계 캡처.png');
  const up = await send(`/api/requests/portal/${id}/attachments`, {
    method: 'POST',
    headers: { 'X-Menu-ID': menu },
    body: form,
  });
  assert.equal(up.status, 201);
  const detail = await (
    await send(`/api/requests/portal/${id}`, { headers: { 'X-Menu-ID': menu } })
  ).json();
  assert.equal(detail.attachments[0].file_name, '중계 캡처.png');
  const down = await send(`/api/requests/portal/${id}/attachments/${detail.attachments[0].id}`, {
    headers: { 'X-Menu-ID': menu },
  });
  assert.equal(down.status, 200);
  assert.ok(Buffer.from(await down.arrayBuffer()).equals(bytes));
});
