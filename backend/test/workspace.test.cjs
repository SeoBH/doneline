/**
 * 워크스페이스(계약 업체) 격리 검증. 운영 워크스페이스와 새 업체 워크스페이스에 각각 고객사·관리자를 만들고
 * 업체 관리자가 다른 업체의 고객사·사용자·감사 기록·전용 RESP를 볼 수 없는지, 공통 구성 화면을 쓸 수 없는지 확인한다.
 * DB 행 수준 보안(RLS)이 워크스페이스 지정 없는 접근을 막는지도 직접 확인한다. _test DB에서만 실행한다.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const argon2 = require('argon2');
const crypto = require('node:crypto');
const { createApp } = require('../dist/app');
const { Db } = require('../dist/db');
const { settings } = require('../dist/config');
const prefix = 'ws_' + crypto.randomBytes(4).toString('hex');
const password = 'Workspace test password 123!';
let app, db, platform, other, root, sharedResp, platformCustomer, otherCustomer, otherAdmin, platformAdmin;

const post = (who, url, data, menu = root) =>
  who.agent
    .post('/api/' + url)
    .set('Origin', settings.origin)
    .set('X-CSRF-Token', who.csrf)
    .set('X-Menu-ID', menu)
    .send(data);
const get = (who, url, menu = root) => who.agent.get('/api/' + url).set('X-Menu-ID', menu);
async function login(loginId) {
  const agent = request.agent(app.getHttpServer());
  const who = { agent, csrf: (await agent.get('/api/auth/csrf').expect(200)).body.csrfToken };
  who.csrf = (await post(who, 'auth/login', { loginId, password }).expect(201)).body.csrfToken;
  return who;
}

before(async () => {
  if (!process.env.PGDATABASE?.endsWith('_test')) throw Error('Isolated DB required');
  app = await createApp();
  db = app.get(Db);
  platform = await db.platformWorkspaceId();
  db.useScriptWorkspace(platform);
  await db.query('DELETE FROM app.login_limits');
  other = (
    await db.query('SELECT app.create_workspace($1,$2) AS id', [prefix.replace('_', '-'), prefix])
  ).rows[0].id;
  // ADMIN과 같은 메뉴(공통 구성 화면 포함)를 가진 공통 SYSTEM RESP. 업체 관리자에게 배정해도
  // 공통 구성 화면은 운영 워크스페이스 검사로 막혀야 한다.
  root = (await db.query("SELECT root_menu_id FROM app.responsibilities WHERE code='ADMIN'")).rows[0]
    .root_menu_id;
  sharedResp = (
    await db.query(
      "INSERT INTO app.responsibilities(code,name,root_menu_id,authority_type) VALUES($1,$1,$2,'SYSTEM') RETURNING id",
      [prefix + '_shared', root],
    )
  ).rows[0].id;
  const hash = await argon2.hash(password);
  platformCustomer = (
    await db.query('INSERT INTO app.customers(code,name) VALUES($1,$1) RETURNING id', [prefix])
  ).rows[0].id;
  await db.query(
    'INSERT INTO app.users(login_id,password_hash,display_name,resp_id,must_change_password) VALUES($1,$2,$1,$3,false)',
    [prefix + '_platform', hash, sharedResp],
  );
  // 다른 업체의 행은 세 번째 인자로 그 워크스페이스를 지정해 만든다. 고객사 코드는 업체마다 따로 고유하다.
  otherCustomer = (
    await db.query('INSERT INTO app.customers(code,name) VALUES($1,$1) RETURNING id', [prefix], other)
  ).rows[0].id;
  await db.query(
    'INSERT INTO app.users(login_id,password_hash,display_name,resp_id,must_change_password) VALUES($1,$2,$1,$3,false)',
    [prefix + '_other', hash, sharedResp],
    other,
  );
  // 두 관리자 모두 로그인해 각 워크스페이스에 LOGIN 감사 기록을 남긴다.
  platformAdmin = await login(prefix + '_platform');
  otherAdmin = await login(prefix + '_other');
});
after(async () => app?.close());

test('workspace admin sees only own customers, users and audit events', async () => {
  const { customers } = (await get(otherAdmin, 'catalogs/customers').expect(200)).body;
  // 같은 테스트 DB에 다른 테스트의 고객사도 쌓이므로 ID를 정확히 비교한다.
  const ids = customers.map((r) => String(r.id));
  assert.ok(ids.includes(String(otherCustomer)));
  assert.ok(!ids.includes(String(platformCustomer)));
  assert.ok(customers.every((r) => String(r.workspace_id) === String(other)));
  // 다른 업체 고객사 ID를 직접 지정해도 RLS로 보이지 않으므로 거절된다.
  const res = await get(otherAdmin, 'accounts/' + platformCustomer);
  assert.ok(res.status >= 400, 'foreign customer must not be readable: ' + res.status);
  const options = (await get(otherAdmin, 'accounts/options').expect(200)).body;
  assert.ok(!options.responsibilities.some((r) => r.code === 'ADMIN'));
  assert.ok(options.responsibilities.some((r) => r.code === prefix + '_shared'));
  const audit = (await get(otherAdmin, 'admin/audit-events').expect(200)).body;
  const events = Array.isArray(audit) ? audit : audit.items || audit.rows || [];
  const platformUser = (
    await db.query('SELECT id FROM app.users WHERE login_id=$1', [prefix + '_platform'])
  ).rows[0].id;
  const otherUser = (
    await db.query('SELECT id FROM app.users WHERE login_id=$1', [prefix + '_other'], other)
  ).rows[0].id;
  assert.ok(events.some((e) => String(e.user_id) === String(otherUser)));
  assert.ok(!events.some((e) => String(e.user_id) === String(platformUser)));
});

test('shared configuration screens are platform-only even when the menu is reachable', async () => {
  await get(otherAdmin, 'registration/screens').expect(403);
  await post(otherAdmin, 'registration/menus/save', { rows: [] }).expect(403);
  await get(platformAdmin, 'registration/screens').expect(200);
});

test('row level security hides rows without or outside a workspace', async () => {
  // 워크스페이스를 지정하지 않으면 업체 데이터가 보이지 않고 쓰기도 거부된다(실패 시 닫힘).
  const none = new Db();
  try {
    assert.equal((await none.query('SELECT count(*)::int n FROM app.customers')).rows[0].n, 0);
    assert.equal((await none.query('SELECT count(*)::int n FROM app.users')).rows[0].n, 0);
    // 오류 문구는 DB 언어 설정에 따라 달라지므로 SQLSTATE 코드로 확인한다.
    // 23502=NOT NULL 위반(워크스페이스 기본값 없음), 42501=행 수준 보안 정책 위반.
    await assert.rejects(
      none.query("INSERT INTO app.customers(code,name) VALUES('x_none','x')"),
      (e) => ['23502', '42501'].includes(e.code),
    );
  } finally {
    await none.onModuleDestroy();
  }
  const seen = (
    await db.query(
      'SELECT id FROM app.customers WHERE id=ANY($1)',
      [[platformCustomer, otherCustomer]],
      other,
    )
  ).rows.map((r) => String(r.id));
  assert.deepEqual(seen, [String(otherCustomer)]);
  // 다른 업체의 고객사에 법인을 붙이는 쓰기는 정책 검사로 거부된다.
  await assert.rejects(
    db.query(
      'INSERT INTO app.corporations(customer_id,code,name) VALUES($1,$2,$2)',
      [platformCustomer, 'X1'],
      other,
    ),
    (e) => e.code === '42501',
  );
  // 다른 업체의 고객사에 사용자를 소속시키는 것도 거부된다(고객사·워크스페이스 복합 외래키).
  await assert.rejects(
    db.query(
      'INSERT INTO app.users(login_id,display_name,customer_id) VALUES($1,$1,$2)',
      [prefix + '_cross', platformCustomer],
      other,
    ),
  );
});

test('login id resolves its own workspace and sessions stay scoped', async () => {
  const me = (await otherAdmin.agent.get('/api/me').expect(200)).body;
  assert.equal(me.user.displayName, prefix + '_other');
  const session = (
    await db.query(
      'SELECT s.workspace_id FROM app.auth_sessions s JOIN app.users u ON u.id=s.user_id WHERE u.login_id=$1 AND s.revoked_at IS NULL',
      [prefix + '_other'],
      other,
    )
  ).rows[0];
  assert.equal(String(session.workspace_id), String(other));
});

test('self-service workspace signup creates an isolated workspace with a ready admin', async () => {
  const code = prefix.replace('_', '-') + '-self';
  const body = {
    workspaceCode: code,
    workspaceName: '셀프 가입 업체',
    loginId: prefix + '_self',
    name: '업체 관리자',
    email: prefix + '_self@example.com',
    mobile: '010-1234-5678',
    password,
  };
  const agent = request.agent(app.getHttpServer());
  const guest = { agent, csrf: (await agent.get('/api/auth/csrf').expect(200)).body.csrfToken };
  await post(guest, 'workspaces/signup', { ...body, workspaceCode: 'Bad Code' }).expect(400);
  await post(guest, 'workspaces/signup', body).expect(201);
  // 같은 업체 코드, 같은 아이디는 각각 409로 거절한다.
  await post(guest, 'workspaces/signup', { ...body, loginId: prefix + '_self2' }).expect(409);
  await post(guest, 'workspaces/signup', { ...body, workspaceCode: code + '2' }).expect(409);
  const admin = await login(prefix + '_self');
  const nav = (await admin.agent.get('/api/navigation').expect(200)).body;
  const codes = nav.screens.map((s) => s.code);
  assert.ok(codes.includes('CUSTOMER_REGISTER') && codes.includes('USER_REGISTER'));
  assert.ok(!codes.includes('SCREEN_REGISTER') && !codes.includes('RESP_REGISTER'));
  const menu = nav.screens.find((s) => s.code === 'CUSTOMER_REGISTER').menu_id;
  const { customers } = (await get(admin, 'catalogs/customers', menu).expect(200)).body;
  assert.deepEqual(customers, []);
  // 새 업체 관리자는 운영 전용 ADMIN을 볼 수 없고 공통 업체 관리자 RESP만 배정할 수 있다.
  const userMenu = nav.screens.find((s) => s.code === 'USER_REGISTER').menu_id;
  const options = (await get(admin, 'accounts/options', userMenu).expect(200)).body;
  assert.ok(!options.responsibilities.some((r) => r.code === 'ADMIN'));
  assert.ok(options.responsibilities.some((r) => r.code === 'WORKSPACE_ADMIN'));
});
