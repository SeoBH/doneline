/** 발송 없이 암호화 보류 메일을 읽어 실제 API의 일회용 링크·고객사 경계·세션 폐기를 검증한다. */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { randomBytes } = require('node:crypto');
const argon2 = require('argon2');
const { createApp } = require('../dist/app');
const { Db } = require('../dist/db');
const { Audit } = require('../dist/audit');
const { settings } = require('../dist/config');
const { openMail } = require('../dist/mail');
let app, db, root, resp, customer, other, admin;
const prefix = 'recovery_' + randomBytes(5).toString('hex'),
  password = 'Recovery original password 123!',
  newer = 'Recovery replacement password 456!';
async function guest() {
  const agent = request.agent(app.getHttpServer());
  return { agent, csrf: (await agent.get('/api/auth/csrf')).body.csrfToken };
}
const post = (who, path, body) =>
  who.agent
    .post('/api/' + path)
    .set('Origin', settings.origin)
    .set('X-CSRF-Token', who.csrf)
    .set('X-Menu-ID', root)
    .send(body);
async function user(name, tenant = null, verified = true) {
  return (
    await db.query(
      `INSERT INTO app.users(login_id,display_name,password_hash,resp_id,must_change_password,email,email_verified_at,customer_id) VALUES($1,$1,$2,$3,false,$4,CASE WHEN $5 THEN now() ELSE NULL END,$6) RETURNING *`,
      [
        prefix + '_' + name,
        await argon2.hash(password),
        resp,
        prefix + '_' + name + '@example.com',
        verified,
        tenant,
      ],
    )
  ).rows[0];
}
async function mail(u) {
  return openMail(
    (
      await db.query(
        "SELECT payload FROM app.mail_outbox WHERE user_id=$1 AND status='HELD' ORDER BY id DESC LIMIT 1",
        [u.id],
      )
    ).rows[0].payload,
  );
}
const token = (m) => m.text.match(/account=(VERIFY|PASSWORD):([a-f0-9]{64})/)[2];
// signupToken: 고객사 가입 링크의 토큰. 빈 값이면 SYSTEM 계정 복구로 처리된다.
const recovery = (who, u, kind = 'PASSWORD', signupToken = '') =>
  post(who, 'recovery/request', { kind, signupToken, loginId: u.login_id, email: u.email });
const tokenOf = async (customerId) =>
  (await db.query('SELECT signup_token FROM app.customers WHERE id=$1', [customerId])).rows[0]
    .signup_token;
before(async () => {
  if (!process.env.PGDATABASE?.endsWith('_test')) throw Error('Isolated DB required');
  app = await createApp();
  db = app.get(Db);
  // 테스트 준비 SQL은 HTTP 요청 밖에서 실행되므로 운영 워크스페이스를 기본 범위로 지정한다.
  db.useScriptWorkspace(await db.platformWorkspaceId());
  const r = (await db.query("SELECT id,root_menu_id FROM app.responsibilities WHERE code='ADMIN'"))
    .rows[0];
  resp = r.id;
  root = r.root_menu_id;
  customer = (
    await db.query('INSERT INTO app.customers(code,name) VALUES($1,$1) RETURNING id', [prefix])
  ).rows[0].id;
  other = (
    await db.query('INSERT INTO app.customers(code,name) VALUES($1,$1) RETURNING id', [
      prefix + '_other',
    ])
  ).rows[0].id;
  const u = await user('admin');
  admin = await guest();
  await db.query('DELETE FROM app.login_limits');
  admin.csrf = (
    await post(admin, 'auth/login', { loginId: u.login_id, password }).expect(201)
  ).body.csrfToken;
});
beforeEach(async () => {
  await db.query('DELETE FROM app.login_limits');
});
after(async () => {
  if (app) await app.close();
});
test('request hides account existence, requires verified email and correct customer; ID stays in mail', async () => {
  const u = await user('unverified', null, false),
    g = await guest();
  const a = await recovery(g, u).expect(201),
    b = await recovery(g, { ...u, email: 'missing@example.com' }).expect(201);
  assert.deepEqual(a.body, b.body);
  assert.equal(
    (await db.query('SELECT 1 FROM app.mail_outbox WHERE user_id=$1', [u.id])).rowCount,
    0,
  );
  await recovery(g, u, 'VERIFY').expect(201);
  const m = await mail(u);
  assert(!JSON.stringify(a.body).includes(token(m)));
  await post(g, 'recovery/redeem', { purpose: 'VERIFY', token: token(m), password: '' }).expect(
    201,
  );
  await recovery(g, u, 'ID').expect(201);
  assert((await mail(u)).text.includes(u.login_id));
  // 테넌트만 보는 요청 검사를 위해 CUSTOMER RESP로 만든 별도 계정을 사용한다.
  const cr = (await db.query("SELECT id FROM app.responsibilities WHERE code='CUSTOMER_USER'"))
    .rows[0].id;
  const t = (
    await db.query(
      `INSERT INTO app.users(login_id,display_name,password_hash,resp_id,email,email_verified_at,customer_id) VALUES($1,$1,$2,$3,$4,now(),$5) RETURNING *`,
      [
        prefix + '_tenant',
        await argon2.hash(password),
        cr,
        prefix + '_tenant@example.com',
        customer,
      ],
    )
  ).rows[0];
  await recovery(g, t, 'PASSWORD', await tokenOf(other)).expect(201);
  assert.equal(
    (await db.query('SELECT 1 FROM app.account_tokens WHERE user_id=$1', [t.id])).rowCount,
    0,
  );
  await recovery(g, t, 'PASSWORD', await tokenOf(customer)).expect(201);
  assert.equal((await mail(t)).to, t.email);
});
test('reset is single use, revokes sessions, and does not change password before redemption', async () => {
  const u = await user('reset'),
    g = await guest(),
    logged = await guest();
  logged.csrf = (
    await post(logged, 'auth/login', { loginId: u.login_id, password }).expect(201)
  ).body.csrfToken;
  await recovery(g, u).expect(201);
  const t = token(await mail(u));
  assert.equal(
    (await db.query('SELECT password_hash FROM app.users WHERE id=$1', [u.id])).rows[0]
      .password_hash,
    u.password_hash,
  );
  await post(g, 'recovery/redeem', { purpose: 'VERIFY', token: t, password: '' }).expect(400);
  await post(g, 'recovery/redeem', { purpose: 'PASSWORD', token: t, password: newer }).expect(201);
  await post(g, 'recovery/redeem', { purpose: 'PASSWORD', token: t, password: newer }).expect(400);
  await logged.agent.get('/api/me').expect(401);
  const fresh = await guest();
  await post(fresh, 'auth/login', { loginId: u.login_id, password: newer }).expect(201);
  const stored = (await db.query('SELECT * FROM app.users WHERE id=$1', [u.id])).rows[0];
  assert.equal(stored.resp_id, u.resp_id);
  assert.equal(stored.account_status, u.account_status);
  assert.equal(
    (await db.query('SELECT 1 FROM app.account_tokens WHERE user_id=$1', [u.id])).rowCount,
    0,
  );
});
test('new link invalidates old one; expiration and email edits prevent redemption', async () => {
  const u = await user('expiry'),
    g = await guest();
  await recovery(g, u).expect(201);
  const old = token(await mail(u));
  await recovery(g, u).expect(201);
  let t = token(await mail(u));
  await post(g, 'recovery/redeem', { purpose: 'PASSWORD', token: old, password: newer }).expect(
    400,
  );
  await db.query(
    "UPDATE app.account_tokens SET expires_at=now()-interval '1 second' WHERE user_id=$1",
    [u.id],
  );
  await post(g, 'recovery/redeem', { purpose: 'PASSWORD', token: t, password: newer }).expect(400);
  await recovery(g, u).expect(201);
  t = token(await mail(u));
  await db.query('UPDATE app.users SET email=$2 WHERE id=$1', [
    u.id,
    prefix + '_changed@example.com',
  ]);
  await post(g, 'recovery/redeem', { purpose: 'PASSWORD', token: t, password: newer }).expect(400);
  assert.equal(
    (await db.query('SELECT email_verified_at FROM app.users WHERE id=$1', [u.id])).rows[0]
      .email_verified_at,
    null,
  );
});
test('concurrent redemption succeeds once and audit failure rolls back token and password', async () => {
  const u = await user('atomic'),
    g = await guest();
  await recovery(g, u).expect(201);
  const t = token(await mail(u));
  const audit = app.get(Audit),
    write = audit.write.bind(audit);
  audit.write = async () => {
    throw Error('test failure');
  };
  try {
    await post(g, 'recovery/redeem', { purpose: 'PASSWORD', token: t, password: newer }).expect(
      500,
    );
  } finally {
    audit.write = write;
  }
  assert.equal(
    (await db.query('SELECT password_hash FROM app.users WHERE id=$1', [u.id])).rows[0]
      .password_hash,
    u.password_hash,
  );
  const results = await Promise.all([
    post(g, 'recovery/redeem', { purpose: 'PASSWORD', token: t, password: newer }),
    post(g, 'recovery/redeem', { purpose: 'PASSWORD', token: t, password: newer }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 400]);
});
test('administrator prepares link using saved email/version, cannot bypass SAVE or suspension', async () => {
  const u = await user('managed', null, false);
  await post(admin, 'accounts/password-link', { userId: u.id, version: u.version + 1 }).expect(409);
  await post(admin, 'accounts/password-link', {
    userId: u.id,
    version: u.version,
    email: 'attacker@example.com',
  }).expect(400);
  await post(admin, 'accounts/password-link', { userId: u.id, version: u.version }).expect(201);
  assert.equal((await mail(u)).to, u.email);
  // 메뉴의 SAVE를 제거하면 로그인한 SYSTEM이라도 링크를 발급할 수 없다.
  const mapping = (
    await db.query(
      "SELECT mb.menu_screen_id,mb.is_allowed FROM app.menu_screen_buttons mb JOIN app.menu_screens ms ON ms.id=mb.menu_screen_id JOIN app.screens s ON s.id=ms.screen_id WHERE ms.menu_id=$1 AND s.code='USER_REGISTER' AND mb.action_code='SAVE'",
      [root],
    )
  ).rows[0];
  await db.query(
    "UPDATE app.menu_screen_buttons SET is_allowed=false WHERE menu_screen_id=$1 AND action_code='SAVE'",
    [mapping.menu_screen_id],
  );
  try {
    await post(admin, 'accounts/password-link', { userId: u.id, version: u.version }).expect(403);
  } finally {
    await db.query(
      "UPDATE app.menu_screen_buttons SET is_allowed=$2 WHERE menu_screen_id=$1 AND action_code='SAVE'",
      [mapping.menu_screen_id, mapping.is_allowed],
    );
  }
  const g = await guest();
  await post(g, 'accounts/password-link', { userId: u.id, version: u.version }).expect(401);
  await db.query("UPDATE app.users SET account_status='SUSPENDED',is_active=false WHERE id=$1", [
    u.id,
  ]);
  const v = (await db.query('SELECT version FROM app.users WHERE id=$1', [u.id])).rows[0].version;
  await post(admin, 'accounts/password-link', { userId: u.id, version: v }).expect(400);
  assert.equal(
    (await db.query('SELECT 1 FROM app.account_tokens WHERE user_id=$1', [u.id])).rowCount,
    0,
  );
});
test('public recovery rejects CSRF and limits repeated requests for missing accounts too', async () => {
  const g = await guest(),
    u = { login_id: 'missing', email: prefix + '_missing@example.com' };
  await g.agent
    .post('/api/recovery/request')
    .send({ kind: 'ID', signupToken: '', loginId: '', email: u.email })
    .expect(403);
  for (let i = 0; i < 5; i++) await recovery(g, u).expect(201);
  await recovery(g, u).expect(429);
});
