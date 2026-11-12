/**
 * 인증 통합 검증. 고유 계정과 메뉴를 준비하고 CSRF·세션 교체·권한 캐시·만료·시도 제한·감사 실패 롤백·최초 비밀번호 변경을 확인한다.
 * _test DB에서만 실행한다.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const argon2 = require('argon2');
const crypto = require('node:crypto');
const { createApp } = require('../dist/app');
const { Db } = require('../dist/db');
const { settings } = require('../dist/config');
let app, db, server, user, root, other, mapping, csrf, agent;
const loginId = 'test_' + crypto.randomBytes(6).toString('hex');
const password = 'Test-only password 12345!';
// 테스트 전용 계정·권한·메뉴를 준비한다. 업무 DB에서 실행되지 않도록 DB 이름 검사를 유지한다.
before(async () => {
  if (!process.env.PGDATABASE?.endsWith('_test'))
    throw new Error('Tests require an isolated *_test database');
  app = await createApp();
  db = app.get(Db);
  // 테스트 준비 SQL은 HTTP 요청 밖에서 실행되므로 운영 워크스페이스를 기본 범위로 지정한다.
  db.useScriptWorkspace(await db.platformWorkspaceId());
  server = app.getHttpServer();
  await db.query("DELETE FROM app.login_limits WHERE bucket LIKE 'ip:%'");
  const hash = await argon2.hash(password);
  await db.tx(async (c) => {
    root = (await c.query('INSERT INTO app.menus(code,name) VALUES($1,$1) RETURNING id', [loginId]))
      .rows[0].id;
    other = (
      await c.query('INSERT INTO app.menus(code,name) VALUES($1,$1) RETURNING id', [
        loginId + '_other',
      ])
    ).rows[0].id;
    const resp = (
      await c.query(
        "INSERT INTO app.responsibilities(code,name,root_menu_id,authority_type) VALUES($1,$1,$2,'SYSTEM') RETURNING id",
        [loginId, root],
      )
    ).rows[0].id;
    user = (
      await c.query(
        'INSERT INTO app.users(login_id,password_hash,display_name,resp_id,must_change_password) VALUES($1,$2,$1,$3,false) RETURNING id',
        [loginId, hash, resp],
      )
    ).rows[0].id;
    await c.query(
      "INSERT INTO app.screens(code,name) VALUES('AUDIT','Audit') ON CONFLICT DO NOTHING",
    );
    const screen = (await c.query("SELECT id FROM app.screens WHERE code='AUDIT'")).rows[0].id;
    await c.query(
      "INSERT INTO app.screen_buttons VALUES($1,'QUERY','Query',true) ON CONFLICT DO NOTHING",
      [screen],
    );
    mapping = (
      await c.query('INSERT INTO app.menu_screens(menu_id,screen_id) VALUES($1,$2) RETURNING id', [
        root,
        screen,
      ])
    ).rows[0].id;
    await c.query("INSERT INTO app.menu_screen_buttons VALUES($1,'QUERY',true)", [mapping]);
  });
  agent = request.agent(server);
  csrf = (await agent.get('/api/auth/csrf').expect(200)).body.csrfToken;
});
// 앱 종료 시 DB 풀과 서버 자원도 함께 반환한다.
after(async () => {
  if (app) await app.close();
});
test('login, CSRF, rotation, menu isolation, cache invalidation, audit, logout', async () => {
  await agent.get('/api/me').expect(401);
  await agent.post('/api/auth/login').send({ loginId, password }).expect(403);
  await agent
    .post('/api/auth/login')
    .set('Origin', 'https://untrusted.invalid')
    .set('X-CSRF-Token', csrf)
    .send({ loginId, password })
    .expect(403);
  await agent
    .post('/api/auth/login')
    .set('Origin', settings.origin)
    .set('X-CSRF-Token', csrf)
    .send({ loginId, password: 'wrong' })
    .expect(401);
  const response = await agent
    .post('/api/auth/login')
    .set('Origin', settings.origin)
    .set('X-CSRF-Token', csrf)
    .send({ loginId, password })
    .expect(201);
  assert.notEqual(response.body.csrfToken, csrf);
  csrf = response.body.csrfToken;
  const cookie = response.headers['set-cookie'].join(';');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  await agent.get('/api/me').expect(200);
  await agent.get('/api/admin/audit-events').set('X-Menu-ID', other).expect(403);
  const events = await agent.get('/api/admin/audit-events').set('X-Menu-ID', root).expect(200);
  assert.ok(
    events.body.items.some(
      (e) => e.action === 'LOGIN' && e.outcome === 'SUCCESS' && e.user_id === user,
    ),
  );
  await db.query('UPDATE app.menu_screen_buttons SET is_allowed=false WHERE menu_screen_id=$1', [
    mapping,
  ]);
  await agent.get('/api/admin/audit-events').set('X-Menu-ID', root).expect(403);
  await db.query('UPDATE app.menu_screen_buttons SET is_allowed=true WHERE menu_screen_id=$1', [
    mapping,
  ]);
  await agent.get('/api/admin/audit-events').set('X-Menu-ID', root).expect(200);
  await agent
    .post('/api/auth/logout')
    .set('Origin', settings.origin)
    .set('X-CSRF-Token', csrf)
    .send({})
    .expect(201);
  await agent.get('/api/me').expect(401);
});
test('expired and revoked sessions cannot access authenticated APIs', async () => {
  const a = request.agent(server);
  let token = (await a.get('/api/auth/csrf')).body.csrfToken;
  await a
    .post('/api/auth/login')
    .set('Origin', settings.origin)
    .set('X-CSRF-Token', token)
    .send({ loginId, password })
    .expect(201);
  await db.query(
    "UPDATE app.auth_sessions SET idle_expires_at=now()-interval '1 second' WHERE user_id=$1",
    [user],
  );
  await a.get('/api/me').expect(401);
  token = (await a.get('/api/auth/csrf')).body.csrfToken;
  await a
    .post('/api/auth/login')
    .set('Origin', settings.origin)
    .set('X-CSRF-Token', token)
    .send({ loginId, password })
    .expect(201);
  await db.query('UPDATE app.users SET is_active=false WHERE id=$1', [user]);
  await a.get('/api/me').expect(401);
  await db.query('UPDATE app.users SET is_active=true WHERE id=$1', [user]);
});
test('unknown login throttles and never logs password values', async () => {
  const a = request.agent(server);
  const token = (await a.get('/api/auth/csrf')).body.csrfToken;
  for (let i = 0; i < 6; i++)
    await a
      .post('/api/auth/login')
      .set('Origin', settings.origin)
      .set('X-CSRF-Token', token)
      .send({ loginId: loginId + '_missing', password })
      .expect(i < 5 ? 401 : 429);
  const logs = await db.query('SELECT * FROM audit.event_summary');
  assert.ok(!JSON.stringify(logs.rows).includes(password));
});

test('login audit failure rolls back authenticated session creation', async () => {
  const { Audit } = require('../dist/audit');
  const audit = app.get(Audit);
  const original = audit.write.bind(audit);
  const beforeCount = (
    await db.query(
      'SELECT count(*) FROM app.auth_sessions WHERE user_id=$1 AND revoked_at IS NULL',
      [user],
    )
  ).rows[0].count;
  const a = request.agent(server);
  const token = (await a.get('/api/auth/csrf')).body.csrfToken;
  audit.write = async (e, c) => {
    if (e.action === 'LOGIN') throw new Error('injected audit failure');
    return original(e, c);
  };
  try {
    await a
      .post('/api/auth/login')
      .set('Origin', settings.origin)
      .set('X-CSRF-Token', token)
      .send({ loginId, password })
      .expect(500);
    await a.get('/api/me').expect(401);
    const afterCount = (
      await db.query(
        'SELECT count(*) FROM app.auth_sessions WHERE user_id=$1 AND revoked_at IS NULL',
        [user],
      )
    ).rows[0].count;
    assert.equal(beforeCount, afterCount);
  } finally {
    audit.write = original;
  }
});
test('first password change blocks business access and revokes existing sessions', async () => {
  const a = request.agent(server);
  let token = (await a.get('/api/auth/csrf')).body.csrfToken;
  await db.query('UPDATE app.users SET must_change_password=true WHERE id=$1', [user]);
  const login = await a
    .post('/api/auth/login')
    .set('Origin', settings.origin)
    .set('X-CSRF-Token', token)
    .send({ loginId, password })
    .expect(201);
  token = login.body.csrfToken;
  await a.get('/api/navigation').expect(403);
  await a
    .post('/api/auth/password')
    .set('Origin', settings.origin)
    .set('X-CSRF-Token', token)
    .send({ currentPassword: password, newPassword: 'short' })
    .expect(400);
  await a
    .post('/api/auth/password')
    .set('Origin', settings.origin)
    .set('X-CSRF-Token', token)
    .send({ currentPassword: password, newPassword: 'Changed test password 123456!' })
    .expect(201);
  await a.get('/api/me').expect(401);
  const u = (await db.query('SELECT must_change_password FROM app.users WHERE id=$1', [user]))
    .rows[0];
  assert.equal(u.must_change_password, false);
});
