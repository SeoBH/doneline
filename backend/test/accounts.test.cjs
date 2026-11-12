/** SYSTEM/CUSTOMER 경계, 등록 배치의 원자성, 승인과 매핑의 분리 및 세션 폐기를 검증한다. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const argon2 = require('argon2');
const { randomBytes } = require('node:crypto');
const { createApp } = require('../dist/app');
const { Db } = require('../dist/db');
const { Audit } = require('../dist/audit');
const { settings } = require('../dist/config');
const { openMail } = require('../dist/mail');
let app,
  db,
  signupPath,
  system,
  manager,
  root,
  managerRoot,
  systemResp,
  managerResp,
  userResp,
  customer,
  foreign,
  corp,
  dept,
  corp2,
  dept2;
const prefix = 'a8_' + randomBytes(5).toString('hex'),
  password = 'Account test password 123!';
const post = (who, url, data, menu = root) =>
  who.agent
    .post('/api/' + url)
    .set('Origin', settings.origin)
    .set('X-CSRF-Token', who.csrf)
    .set('X-Menu-ID', menu)
    .send(data);
const get = (who, url, menu = root) => who.agent.get('/api/' + url).set('X-Menu-ID', menu);
async function guest() {
  const agent = request.agent(app.getHttpServer());
  return { agent, csrf: (await agent.get('/api/auth/csrf').expect(200)).body.csrfToken };
}
async function login(name, status = 201) {
  const who = await guest();
  const res = await post(who, 'auth/login', { loginId: prefix + '_' + name, password }).expect(
    status,
  );
  if (status === 201) who.csrf = res.body.csrfToken;
  return who;
}
const account = (name, respId = userResp) => ({
  loginId: prefix + '_' + name,
  name,
  address: '서울',
  mobile: '010-1234-5678',
  email: prefix + '_' + name + '@example.com',
  respId,
});
const signup = (name) => {
  const { respId, ...body } = account(name);
  return { ...body, password };
};
const user = async (name) =>
  (await db.query('SELECT * FROM app.users WHERE login_id=$1', [prefix + '_' + name])).rows[0];
async function setupPassword(name) {
  const u = await user(name);
  const mail = (
    await db.query(
      "SELECT payload FROM app.mail_outbox WHERE user_id=$1 AND status='HELD' ORDER BY id DESC LIMIT 1",
      [u.id],
    )
  ).rows[0];
  const token = /PASSWORD:([a-f0-9]{64})/.exec(openMail(mail.payload).text)[1];
  await post(await guest(), 'recovery/redeem', { token, purpose: 'PASSWORD', password }).expect(
    201,
  );
}
async function catalog(kind, code, customerId, corporationId, who = system, menu = root) {
  return (
    await post(
      who,
      'catalogs/' + kind + '/save',
      { customerId, corporationId, rows: [{ code, name: code, clientKey: code }] },
      menu,
    ).expect(201)
  ).body.items[0].item;
}
async function assign(name, respId = userResp) {
  const u = await user(name);
  await post(
    manager,
    'accounts/update',
    {
      userId: u.id,
      version: u.version,
      name: u.display_name,
      address: u.address,
      mobile: u.mobile,
      customerId: u.customer_id,
      respId,
    },
    managerRoot,
  ).expect(201);
  return user(name);
}
async function map(
  name,
  corporations = [corp.id],
  departments = [dept.id],
  who = system,
  menu = root,
) {
  const u = await user(name);
  return post(
    who,
    'accounts/mapping',
    { userId: u.id, version: u.version, corporationIds: corporations, departmentIds: departments },
    menu,
  );
}
before(async () => {
  if (!process.env.PGDATABASE?.endsWith('_test')) throw Error('Isolated DB required');
  app = await createApp();
  db = app.get(Db);
  // 테스트 준비 SQL은 HTTP 요청 밖에서 실행되므로 운영 워크스페이스를 기본 범위로 지정한다.
  db.useScriptWorkspace(await db.platformWorkspaceId());
  await db.query('DELETE FROM app.login_limits');
  const res = (
    await db.query(
      "SELECT id,code,root_menu_id FROM app.responsibilities WHERE code IN('ADMIN','CUSTOMER_MANAGER','CUSTOMER_USER')",
    )
  ).rows;
  const admin = res.find((r) => r.code === 'ADMIN'),
    mgr = res.find((r) => r.code === 'CUSTOMER_MANAGER');
  root = admin.root_menu_id;
  systemResp = admin.id;
  managerRoot = mgr.root_menu_id;
  managerResp = mgr.id;
  userResp = res.find((r) => r.code === 'CUSTOMER_USER').id;
  await db.query(
    'INSERT INTO app.users(login_id,password_hash,display_name,resp_id,must_change_password) VALUES($1,$2,$1,$3,false)',
    [prefix + '_system', await argon2.hash(password), systemResp],
  );
  system = await login('system');
  customer = await catalog('customers', prefix);
  // 가입 링크는 고객사 코드가 아니라 고객사마다 발급된 무작위 토큰을 쓴다.
  signupPath =
    'signup/' +
    (await db.query('SELECT signup_token FROM app.customers WHERE id=$1', [customer.id])).rows[0]
      .signup_token;
  foreign = await catalog('customers', prefix + '_foreign');
  corp = await catalog('corporations', 'A001', customer.id);
  dept = await catalog('departments', 'D001', customer.id, corp.id);
  corp2 = await catalog('corporations', 'A002', customer.id);
  dept2 = await catalog('departments', 'D002', customer.id, corp2.id);
  await post(system, 'accounts', {
    ...account('manager', managerResp),
    customerId: customer.id,
  }).expect(201);
  await setupPassword('manager');
  await map('manager').then((r) => assert.equal(r.status, 201));
  await db.query('UPDATE app.users SET must_change_password=false WHERE login_id=$1', [
    prefix + '_manager',
  ]);
  manager = await login('manager');
});
after(async () => {
  if (app) await app.close();
});
test('customer catalogs are isolated, parent ownership checked, assigned deletes rejected', async () => {
  const options = (await get(manager, 'catalogs/departments', managerRoot).expect(200)).body;
  assert.deepEqual(
    options.customers.map((c) => c.id),
    [customer.id],
  );
  await get(manager, 'catalogs/customers', managerRoot).expect(403);
  await post(
    manager,
    'catalogs/corporations/save',
    { customerId: foreign.id, rows: [{ code: 'BAD', name: 'bad' }] },
    managerRoot,
  ).expect(403);
  // 개인 매핑에 없는 A002도 자기 고객사 관리 권한으로 부서를 만들 수 있다.
  await catalog('departments', 'NONE', customer.id, corp2.id, manager, managerRoot);
  await post(system, 'catalogs/corporations/delete', {
    customerId: customer.id,
    rows: [{ id: corp.id, version: corp.version }],
  }).expect(400);
});
test('selected catalog rows commit together, stale versions and immutable codes reject', async () => {
  const v = await catalog('corporations', 'EDIT', customer.id);
  await post(system, 'catalogs/corporations/save', {
    customerId: customer.id,
    rows: [
      { id: v.id, version: v.version, code: v.code, name: 'changed' },
      { code: 'A001', name: 'duplicate' },
    ],
  }).expect(409);
  assert.equal(
    (await db.query('SELECT name FROM app.corporations WHERE id=$1', [v.id])).rows[0].name,
    'EDIT',
  );
  const saved = (
    await post(system, 'catalogs/corporations/save', {
      customerId: customer.id,
      rows: [{ id: v.id, version: v.version, code: v.code, name: 'changed' }],
    }).expect(201)
  ).body.items[0].item;
  await post(system, 'catalogs/corporations/delete', {
    customerId: customer.id,
    rows: [{ id: v.id, version: v.version }],
  }).expect(409);
  await post(system, 'catalogs/corporations/save', {
    customerId: customer.id,
    rows: [{ id: v.id, version: saved.version, code: 'RENAMED', name: 'changed' }],
  }).expect(400);
  await post(system, 'catalogs/corporations/delete', {
    customerId: customer.id,
    rows: [{ id: v.id, version: saved.version }],
  }).expect(201);
});
test('signup stores no RESP and rejects injected customer, scopes and RESP', async () => {
  const data = (await get(system, signupPath).expect(200)).body;
  assert.deepEqual(data, { ok: true });
  const g = await guest();
  await post(g, signupPath, { ...account('bad'), customerId: foreign.id }).expect(400);
  await post(g, signupPath, { ...account('bad'), scopes: [] }).expect(400);
  await post(g, signupPath, account('bad', systemResp)).expect(400);
  await post(g, signupPath, signup('applicant')).expect(201);
  const u = await user('applicant');
  assert.equal(u.account_status, 'PENDING');
  assert.equal(u.resp_id, null);
  assert.equal(
    (await db.query('SELECT count(*)::int n FROM app.user_scopes WHERE user_id=$1', [u.id]))
      .rows[0].n,
    0,
  );
  await login('applicant', 401);
  const list = (await get(manager, 'accounts/' + customer.id, managerRoot).expect(200)).body.items;
  assert(list.some((r) => r.id === u.id));
  await get(manager, 'accounts/' + foreign.id, managerRoot).expect(403);
});
test('manager approves same manager RESP; approval alone does not allow login; each corporation needs departments', async () => {
  let u = await user('applicant');
  await post(
    manager,
    'accounts/approve',
    {
      customerId: customer.id,
      note: '',
      rows: [{ id: u.id, version: u.version, respId: systemResp }],
    },
    managerRoot,
  ).expect(400);
  await post(
    manager,
    'accounts/approve',
    { customerId: customer.id, note: '', rows: [{ id: u.id, version: u.version }] },
    managerRoot,
  ).expect(400);
  u = await assign('applicant', managerResp);
  await post(
    manager,
    'accounts/approve',
    {
      customerId: customer.id,
      note: '',
      rows: [{ id: u.id, version: u.version }],
    },
    managerRoot,
  ).expect(201);
  await login('applicant', 401);
  assert.equal(
    (await map('applicant', [corp.id, corp2.id], [dept.id], manager, managerRoot)).status,
    201,
  );
  await login('applicant', 401);
  const wrong = await map('applicant', [corp.id], [dept2.id], manager, managerRoot);
  assert.equal(wrong.status, 400);
  assert.equal(
    (await map('applicant', [corp.id, corp2.id], [dept.id, dept2.id], manager, managerRoot)).status,
    201,
  );
  const who = await login('applicant');
  await get(who, 'me').expect(200);
  // 매핑 변경 직후 기존 세션이 더 이상 권한을 사용하지 못한다.
  assert.equal((await map('applicant', [], [], manager, managerRoot)).status, 201);
  await get(who, 'me').expect(401);
});
test('mapping permission is independent from SAVE, cross-customer and stale requests fail', async () => {
  const u = await user('applicant');
  await post(
    manager,
    'accounts/mapping',
    { userId: u.id, version: u.version - 1, corporationIds: [], departmentIds: [] },
    managerRoot,
  ).expect(409);
  const foreignCorp = await catalog('corporations', 'F001', foreign.id);
  assert.equal((await map('applicant', [foreignCorp.id], [], manager, managerRoot)).status, 400);
  await db.query(
    "UPDATE app.menu_screen_buttons mb SET is_allowed=false FROM app.menu_screens ms JOIN app.screens s ON s.id=ms.screen_id WHERE mb.menu_screen_id=ms.id AND ms.menu_id=$1 AND s.code='USER_REGISTER' AND mb.action_code='ETC4'",
    [managerRoot],
  );
  try {
    assert.equal((await map('applicant', [corp.id], [dept.id], manager, managerRoot)).status, 403);
  } finally {
    await db.query(
      "UPDATE app.menu_screen_buttons mb SET is_allowed=true FROM app.menu_screens ms JOIN app.screens s ON s.id=ms.screen_id WHERE mb.menu_screen_id=ms.id AND ms.menu_id=$1 AND s.code='USER_REGISTER' AND mb.action_code='ETC4'",
      [managerRoot],
    );
  }
});
test('direct creation, profile customer reassignment clears mapping, audit failure rolls back', async () => {
  await post(
    manager,
    'accounts',
    { ...account('direct'), customerId: customer.id },
    managerRoot,
  ).expect(201);
  let u = await user('direct');
  assert.equal(u.account_status, 'ACTIVE');
  assert.equal(u.must_change_password, false);
  assert.equal(u.password_hash, null);
  await login('direct', 401);
  assert.equal((await map('direct')).status, 201);
  u = await user('direct');
  await post(
    manager,
    'accounts/update',
    {
      userId: u.id,
      version: u.version,
      name: 'direct',
      address: '',
      mobile: '010-1111-2222',
      customerId: customer.id,
      respId: systemResp,
    },
    managerRoot,
  ).expect(400);
  await post(system, 'accounts/update', {
    userId: u.id,
    version: u.version,
    name: 'direct',
    address: '',
    mobile: '010-1111-2222',
    customerId: foreign.id,
    respId: userResp,
  }).expect(201);
  assert.equal(
    (await db.query('SELECT mapping_ready FROM app.account_access WHERE id=$1', [u.id]))
      .rows[0].mapping_ready,
    false,
  );
  const audit = app.get(Audit),
    original = audit.write;
  audit.write = async () => {
    throw Error('injected');
  };
  try {
    await post(system, 'accounts', { ...account('rollback'), customerId: customer.id }).expect(500);
  } finally {
    audit.write = original;
  }
  assert.equal(await user('rollback'), undefined);
});
test('RESP defaults to CUSTOMER, assigned type change rejected, new SYSTEM is explicit', async () => {
  const saved = (
    await post(system, 'registration/responsibilities/save', {
      rows: [{ code: prefix + '_resp', name: '별도 RESP', authority_type: 'SYSTEM' }],
    }).expect(201)
  ).body.items[0].item;
  assert.equal(saved.authority_type, 'SYSTEM');
  const assigned = (
    await db.query('SELECT * FROM app.responsibilities WHERE id=$1', [managerResp])
  ).rows[0];
  await post(system, 'registration/responsibilities/save', {
    rows: [
      {
        id: assigned.id,
        version: assigned.version,
        code: assigned.code,
        name: assigned.name,
        authority_type: 'SYSTEM',
      },
    ],
  }).expect(409);
  await get(manager, 'registration/responsibilities', managerRoot).expect(403);
  const opts = (await get(manager, 'accounts/options', managerRoot).expect(200)).body;
  assert(opts.responsibilities.every((r) => r.authority_type === 'CUSTOMER'));
});

test('RESP levels allow zero and peers, reject invalid values, and preserve authority type', async () => {
  for (const level of [-1, 1.5, 10000, '10']) {
    await post(system, 'registration/responsibilities/save', {
      rows: [{ code: prefix + '_badlevel', name: '잘못된 레벨', level }],
    }).expect(400);
  }
  const saved = (
    await post(system, 'registration/responsibilities/save', {
      rows: [
        { code: prefix + '_level0a', name: '동급 A', level: 0 },
        { code: prefix + '_level0b', name: '동급 B', level: 0 },
      ],
    }).expect(201)
  ).body.items;
  assert(saved.every((r) => r.item.level === 0 && r.item.authority_type === 'CUSTOMER'));
});

// 상태 처리는 선택 행 전체가 원자적이며 정지하면 이미 로그인한 세션도 무효다.
test('review batch rollback, rejection and suspension preserve state rules', async () => {
  const g = await guest();
  await post(g, signupPath, signup('reject')).expect(201);
  await post(g, signupPath, signup('approve')).expect(201);
  const rejected = await assign('reject'),
    approved = await assign('approve');
  await post(
    manager,
    'accounts/approve',
    {
      customerId: customer.id,
      note: '',
      rows: [
        { id: rejected.id, version: rejected.version },
        { id: approved.id, version: approved.version - 1 },
      ],
    },
    managerRoot,
  ).expect(409);
  assert.equal((await user('reject')).account_status, 'PENDING');
  await post(
    manager,
    'accounts/reject',
    {
      customerId: customer.id,
      note: '확인 불가',
      rows: [{ id: rejected.id, version: rejected.version }],
    },
    managerRoot,
  ).expect(201);
  await login('reject', 401);
  await post(
    manager,
    'accounts/approve',
    {
      customerId: customer.id,
      note: '',
      rows: [{ id: approved.id, version: approved.version }],
    },
    managerRoot,
  ).expect(201);
  assert.equal((await map('approve')).status, 201);
  const who = await login('approve');
  const current = await user('approve');
  await post(
    manager,
    'accounts/suspend',
    { customerId: customer.id, note: '', rows: [{ id: current.id, version: current.version }] },
    managerRoot,
  ).expect(400);
  await post(
    manager,
    'accounts/suspend',
    {
      customerId: customer.id,
      note: '사용 중지',
      rows: [{ id: current.id, version: current.version }],
    },
    managerRoot,
  ).expect(201);
  await get(who, 'me').expect(401);
  assert.equal((await user('approve')).account_status, 'SUSPENDED');
});

test('reapproval requires reason and RESP, retains mapping, and refuses duplicate approval', async () => {
  let u = await user('approve');
  await post(
    manager,
    'accounts/approve',
    { customerId: customer.id, note: '', rows: [{ id: u.id, version: u.version }] },
    managerRoot,
  ).expect(400);
  await post(
    manager,
    'accounts/approve',
    { customerId: customer.id, note: '실수 복구', rows: [{ id: u.id, version: u.version }] },
    managerRoot,
  ).expect(201);
  await login('approve');
  u = await user('approve');
  assert.equal(u.review_note, '실수 복구');
  await post(
    manager,
    'accounts/approve',
    { customerId: customer.id, note: '중복', rows: [{ id: u.id, version: u.version }] },
    managerRoot,
  ).expect(409);
  await db.query('UPDATE app.users SET resp_id=NULL WHERE login_id=$1', [prefix + '_reject']);
  u = await user('reject');
  await post(
    manager,
    'accounts/approve',
    { customerId: customer.id, note: '다시 확인', rows: [{ id: u.id, version: u.version }] },
    managerRoot,
  ).expect(400);
  u = await assign('reject');
  await post(
    manager,
    'accounts/approve',
    {
      customerId: customer.id,
      note: '다시 확인',
      rows: [{ id: u.id, version: u.version }],
    },
    managerRoot,
  ).expect(201);
  await login('reject', 401);
});
test('real deletion removes mappings and sessions, preserves audit, rejects own/history/foreign targets atomically', async () => {
  await post(system, 'accounts', { ...account('delete'), customerId: customer.id }).expect(201);
  await setupPassword('delete');
  await map('delete');
  await db.query('UPDATE app.users SET must_change_password=false WHERE login_id=$1', [
    prefix + '_delete',
  ]);
  const who = await login('delete'),
    u = await user('delete'),
    mgr = await user('manager');
  await post(
    manager,
    'accounts/delete',
    { rows: [{ id: mgr.id, version: mgr.version }] },
    managerRoot,
  ).expect(403);
  await post(system, 'accounts/delete', {
    rows: [
      { id: u.id, version: u.version },
      { id: mgr.id, version: mgr.version },
    ],
  }).expect(409);
  assert(await user('delete'));
  await get(who, 'me').expect(200);
  await post(
    manager,
    'accounts/delete',
    { rows: [{ id: u.id, version: u.version - 1 }] },
    managerRoot,
  ).expect(409);
  await post(
    manager,
    'accounts/delete',
    { rows: [{ id: u.id, version: u.version }] },
    managerRoot,
  ).expect(201);
  assert.equal(await user('delete'), undefined);
  await get(who, 'me').expect(401);
  for (const table of ['user_scopes', 'user_corporations', 'auth_sessions'])
    assert.equal(
      (
        await db.query('SELECT count(*)::int n FROM app.' + table + ' WHERE user_id=$1', [
          u.id,
        ])
      ).rows[0].n,
      0,
    );
  assert(
    (await db.query('SELECT 1 FROM audit.event_summary WHERE user_id=$1', [u.id])).rowCount >
      0,
  );
  const foreignUser = await user('direct');
  await post(
    manager,
    'accounts/delete',
    { rows: [{ id: foreignUser.id, version: foreignUser.version }] },
    managerRoot,
  ).expect(403);
  const noRights = await login('approve');
  await post(
    noRights,
    'accounts/delete',
    { rows: [{ id: foreignUser.id, version: foreignUser.version }] },
    managerRoot,
  ).expect(403);
});
