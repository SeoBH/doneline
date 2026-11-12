/**
 * 등록 통합 검증. 고유 RESP·메뉴·화면을 준비하여 일괄 처리, 버전 충돌, 연결 권한과 참조 제약을 실제 API/DB로 확인한다.
 * 생성 데이터는 격리 테스트 DB에 남는다.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const argon2 = require('argon2');
const crypto = require('node:crypto');
const { createApp } = require('../dist/app');
const { Db } = require('../dist/db');
const { settings } = require('../dist/config');
let app,
  db,
  agent,
  csrf,
  root,
  resp,
  ids = {};
const prefix = 'reg_' + crypto.randomBytes(5).toString('hex');
const password = 'Registration test password 123!';
const flags = (value = true) =>
  Object.fromEntries(
    ['RESET', 'QUERY', 'SAVE', 'DELETE', 'ETC1', 'ETC2', 'ETC3', 'ETC4'].map((a) => [a, value]),
  );
const post = (url, body, menu = root) =>
  agent
    .post('/api/registration/' + url)
    .set('Origin', settings.origin)
    .set('X-CSRF-Token', csrf)
    .set('X-Menu-ID', menu)
    .send(body);
const get = (url, menu = root) => agent.get('/api/registration/' + url).set('X-Menu-ID', menu);
// 테스트 전용 계정·권한·메뉴를 준비한다. 업무 DB에서 실행되지 않도록 DB 이름 검사를 유지한다.
before(async () => {
  if (!process.env.PGDATABASE?.endsWith('_test')) throw Error('Isolated test DB required');
  app = await createApp();
  db = app.get(Db);
  // 테스트 준비 SQL은 HTTP 요청 밖에서 실행되므로 운영 워크스페이스를 기본 범위로 지정한다.
  db.useScriptWorkspace(await db.platformWorkspaceId());
  await db.query("DELETE FROM app.login_limits WHERE bucket LIKE 'ip:%'");
  root = (
    await db.query('INSERT INTO app.menus(code,name) VALUES($1,$1) RETURNING id', [prefix])
  ).rows[0].id;
  resp = (
    await db.query(
      "INSERT INTO app.responsibilities(code,name,root_menu_id,authority_type) VALUES($1,$1,$2,'SYSTEM') RETURNING id",
      [prefix, root],
    )
  ).rows[0].id;
  await db.query(
    'INSERT INTO app.users(login_id,password_hash,display_name,resp_id,must_change_password) VALUES($1,$2,$1,$3,false)',
    [prefix, await argon2.hash(password), resp],
  );
  for (const code of ['SCREEN_REGISTER', 'MENU_REGISTER', 'RESP_REGISTER']) {
    const id = (await db.query('SELECT id FROM app.screens WHERE code=$1', [code])).rows[0].id;
    ids[code] = id;
    const map = (
      await db.query(
        'INSERT INTO app.menu_screens(menu_id,screen_id) VALUES($1,$2) RETURNING id',
        [root, id],
      )
    ).rows[0].id;
    for (const a of ['RESET', 'QUERY', 'SAVE', 'DELETE'])
      await db.query('INSERT INTO app.menu_screen_buttons VALUES($1,$2,true)', [map, a]);
  }
  agent = request.agent(app.getHttpServer());
  csrf = (await agent.get('/api/auth/csrf')).body.csrfToken;
  csrf = (
    await agent
      .post('/api/auth/login')
      .set('Origin', settings.origin)
      .set('X-CSRF-Token', csrf)
      .send({ loginId: prefix, password })
      .expect(201)
  ).body.csrfToken;
});
// 앱 종료 시 DB 풀과 서버 자원도 함께 반환한다.
after(async () => {
  if (app) await app.close();
});
test('batch create/update, immutable codes, row errors and full rollback', async () => {
  const rows = [
    { clientKey: 'a', code: prefix + '_a', name: 'A' },
    { clientKey: 'b', code: prefix + '_a', name: 'B' },
  ];
  const failed = await post('menus/save', { rows }).expect(409);
  assert.equal(failed.body.rowErrors[0].clientKey, 'b');
  assert.equal((await get('menus?code=' + prefix + '_a')).body.items.length, 0);
  rows[1].code = prefix + '_b';
  const saved = (await post('menus/save', { rows }).expect(201)).body.items;
  ids.a = saved[0].item;
  ids.b = saved[1].item;
  const a = ids.a,
    b = ids.b;
  await post('menus/save', {
    rows: [
      { id: a.id, version: a.version, code: a.code, name: 'Updated' },
      { id: b.id, version: b.version, code: b.code + 'x', name: 'B' },
    ],
  }).expect(400);
  assert.equal((await get('menus?code=' + a.code)).body.items[0].name, 'A');
  ids.a = (
    await post('menus/save', {
      rows: [{ id: a.id, version: a.version, code: a.code, name: 'Updated' }],
    }).expect(201)
  ).body.items[0].item;
  await post('menus/save', {
    rows: [{ id: a.id, version: a.version, code: a.code, name: 'Stale' }],
  }).expect(409);
});
test('screen source and eight flags saved; atomic deletion preserves preceding valid row', async () => {
  ids.screen = (
    await post('screens/save', {
      rows: [
        { code: prefix + '_screen', name: 'Sample', component_key: 'sample', buttons: flags() },
      ],
    }).expect(201)
  ).body.items[0].item;
  assert.equal(ids.screen.component_key, 'sample');
  const result = await post('menus/delete', {
    rows: [
      { id: ids.b.id, version: ids.b.version, clientKey: 'b' },
      { id: root, version: 1, clientKey: 'root' },
    ],
  }).expect(409);
  assert.equal(result.body.rowErrors[0].clientKey, 'root');
  assert.equal((await get('menus?code=' + ids.b.code)).body.items.length, 1);
});
test('mixed layout order, hidden authorization, shared children and cycle rollback', async () => {
  const layout = [
    { kind: 'F', target_id: ids.screen.id, hidden: true, buttons: flags() },
    { kind: 'M', target_id: ids.b.id, hidden: false },
  ];
  const r = (
    await post('menus/' + ids.a.id + '/apply', { version: ids.a.version, rows: layout }).expect(201)
  ).body;
  ids.a = r.parent;
  assert.deepEqual(
    r.rows.map((x) => [x.kind, x.sort_order, x.hidden]),
    [
      ['F', 0, true],
      ['M', 1, false],
    ],
  );
  await post('menus/' + ids.b.id + '/apply', {
    version: ids.b.version,
    rows: [{ kind: 'M', target_id: ids.a.id, hidden: false }],
  }).expect(409);
  assert.equal((await get('menus/' + ids.b.id + '/layout')).body.rows.length, 0);
  // A second parent shares B; changing B is visible from both parent paths.
  const c = (await post('menus/save', { rows: [{ code: prefix + '_c', name: 'C' }] })).body.items[0]
    .item;
  await post('menus/' + c.id + '/apply', {
    version: c.version,
    rows: [{ kind: 'M', target_id: ids.b.id, hidden: true }],
  }).expect(201);
  const existing = (await get('menus/' + root + '/layout')).body;
  await post('menus/' + root + '/apply', {
    version: existing.parent.version,
    rows: [
      ...existing.rows.map((x) => ({
        kind: x.kind,
        target_id: x.target_id,
        hidden: x.hidden,
        buttons: x.buttons,
      })),
      { kind: 'M', target_id: ids.a.id, hidden: false },
      { kind: 'M', target_id: c.id, hidden: false },
    ],
  }).expect(201);
  const nav = (await agent.get('/api/navigation').expect(200)).body;
  assert.ok(nav.screens.some((s) => s.id === ids.screen.id && s.hidden && s.buttons.SAVE.allowed));
  assert.equal(nav.edges.filter((e) => e.child_menu_id === ids.b.id).length, 2);
});
test('RESP starts without a menu, supports replacement, rejects unlink and assigned deletion', async () => {
  let r = (
    await post('responsibilities/save', {
      rows: [{ code: prefix + '_resp', name: 'New RESP' }],
    }).expect(201)
  ).body.items[0].item;
  assert.equal(r.root_menu_id, null);
  r = (
    await post('responsibilities/' + r.id + '/apply', {
      version: r.version,
      menuId: ids.a.id,
    }).expect(201)
  ).body.parent;
  const detail = (await get('responsibilities/' + r.id + '/link').expect(200)).body.parent;
  assert.equal(detail.menu_code, ids.a.code);
  r = (
    await post('responsibilities/' + r.id + '/apply', {
      version: r.version,
      menuId: ids.b.id,
    }).expect(201)
  ).body.parent;
  await post('responsibilities/' + r.id + '/apply', { version: r.version, menuId: null }).expect(
    400,
  );
  const assigned = (await get('responsibilities?code=' + prefix)).body.items.find(
    (x) => x.id === resp,
  );
  await post('responsibilities/delete', { rows: [{ id: resp, version: assigned.version }] }).expect(
    409,
  );
  await post('responsibilities/delete', { rows: [{ id: r.id, version: r.version }] }).expect(201);
});
test('menu context permission is enforced on server; action grants are independent', async () => {
  const detail = (await get('menus/' + ids.b.id + '/layout')).body;
  await post('menus/' + ids.b.id + '/apply', {
    version: detail.parent.version,
    rows: [
      {
        kind: 'F',
        target_id: ids.MENU_REGISTER,
        hidden: false,
        buttons: { ...flags(false), QUERY: true },
      },
    ],
  }).expect(201);
  await get('menus', ids.b.id).expect(200);
  await post(
    'menus/save',
    { rows: [{ code: prefix + '_denied', name: 'Denied' }] },
    ids.b.id,
  ).expect(403);
  await get('screens', ids.b.id).expect(403);
  await agent.get('/api/admin/config').set('X-Menu-ID', root).expect(404);
  const log = (
    await db.query('SELECT * FROM audit.config_changes WHERE entity_key=$1 ORDER BY id DESC', [
      ids.a.id,
    ])
  ).rows;
  assert.ok(log.length > 0);
});
