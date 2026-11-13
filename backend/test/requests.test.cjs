/**
 * 고객 요청(SR) 흐름 검증. 새 워크스페이스에 고객사·법인·부서 2개·업체 관리자·업체 담당자·고객사 사용자 2명을 만들고
 * 등록 → 배정·처리 → 고객 확인, 부서 범위 제한, 내부 메모 비공개, 동시 편집 충돌, 상태 규칙, 알림, 업체 간 격리를 확인한다.
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
const prefix = 'sr_' + crypto.randomBytes(4).toString('hex');
const password = 'Request test password 123!';
let app, db, ws, admin, engineer, engineer2, u1, u2, platformAdmin, srId, version;

const post = (who, url, data, menu = who.menu) =>
  who.agent
    .post('/api/' + url)
    .set('Origin', settings.origin)
    .set('X-CSRF-Token', who.csrf)
    .set('X-Menu-ID', menu)
    .send(data);
const get = (who, url, menu = who.menu) => who.agent.get('/api/' + url).set('X-Menu-ID', menu);
// 로그인 후 해당 화면(SR_PORTAL 또는 SR_DESK)이 있는 메뉴 ID를 찾아 둔다.
async function login(loginId, screen) {
  const agent = request.agent(app.getHttpServer());
  const who = { agent, csrf: (await agent.get('/api/auth/csrf').expect(200)).body.csrfToken };
  who.csrf = (await post(who, 'auth/login', { loginId, password }, '0').expect(201)).body.csrfToken;
  const nav = (await agent.get('/api/navigation').expect(200)).body;
  who.menu = nav.screens.find((s) => s.code === screen)?.menu_id;
  assert.ok(who.menu, loginId + ' must see ' + screen);
  return who;
}
const user = async (name, w = ws) =>
  (await db.query('SELECT id FROM app.users WHERE login_id=$1', [prefix + '_' + name], w)).rows[0]
    .id;

before(async () => {
  if (!process.env.PGDATABASE?.endsWith('_test')) throw Error('Isolated DB required');
  app = await createApp();
  db = app.get(Db);
  const platform = await db.platformWorkspaceId();
  db.useScriptWorkspace(platform);
  await db.query('DELETE FROM app.login_limits');
  const hash = await argon2.hash(password);
  ws = String(
    (await db.query('SELECT app.create_workspace($1,$2) AS id', [prefix.replace('_', '-'), prefix]))
      .rows[0].id,
  );
  // 새 워크스페이스 안에 고객사·법인·부서와 계정을 만든다(세 번째 인자로 범위 지정).
  await db.tx(async (c) => {
    const resp = async (code) =>
      (await c.query('SELECT id FROM app.responsibilities WHERE code=$1', [code])).rows[0].id;
    const customer = (
      await c.query('INSERT INTO app.customers(code,name) VALUES($1,$1) RETURNING id', [prefix])
    ).rows[0].id;
    const corp = (
      await c.query(
        "INSERT INTO app.corporations(customer_id,code,name) VALUES($1,'C1','법인1') RETURNING id",
        [customer],
      )
    ).rows[0].id;
    const dept = async (code) =>
      (
        await c.query(
          'INSERT INTO app.departments(customer_id,corporation_id,code,name) VALUES($1,$2,$3,$3) RETURNING id',
          [customer, corp, code],
        )
      ).rows[0].id;
    const d1 = await dept('D1'),
      d2 = await dept('D2');
    const add = async (name, respCode, customerId) =>
      (
        await c.query(
          'INSERT INTO app.users(login_id,password_hash,display_name,resp_id,must_change_password,customer_id) VALUES($1,$2,$3,$4,false,$5) RETURNING id',
          [prefix + '_' + name, hash, name, await resp(respCode), customerId],
        )
      ).rows[0].id;
    await add('admin', 'WORKSPACE_ADMIN', null);
    await add('engineer', 'WORKSPACE_ENGINEER', null);
    await add('engineer2', 'WORKSPACE_ENGINEER', null);
    for (const [name, d] of [
      ['u1', d1],
      ['u2', d2],
    ]) {
      const id = await add(name, 'CUSTOMER_USER', customer);
      await c.query(
        'INSERT INTO app.user_corporations(customer_id,user_id,corporation_id) VALUES($1,$2,$3)',
        [customer, id, corp],
      );
      await c.query(
        'INSERT INTO app.user_scopes(customer_id,user_id,corporation_id,department_id) VALUES($1,$2,$3,$4)',
        [customer, id, corp, d],
      );
    }
  }, ws);
  await db.query(
    "INSERT INTO app.users(login_id,password_hash,display_name,resp_id,must_change_password) SELECT $1,$2,$1,id,false FROM app.responsibilities WHERE code='ADMIN'",
    [prefix + '_platform', hash],
  );
  admin = await login(prefix + '_admin', 'SR_DESK');
  engineer = await login(prefix + '_engineer', 'SR_DESK');
  engineer2 = await login(prefix + '_engineer2', 'SR_DESK');
  u1 = await login(prefix + '_u1', 'SR_PORTAL');
  u2 = await login(prefix + '_u2', 'SR_PORTAL');
  platformAdmin = await login(prefix + '_platform', 'SR_DESK');
});
after(async () => app?.close());

test('customer registers within own department scope only', async () => {
  const { scopes } = (await get(u1, 'requests/portal').expect(200)).body;
  assert.equal(scopes.length, 1);
  const own = scopes[0];
  const base = { title: 'VPN 접속 불가', body: '아침부터 접속이 안 됩니다.', category: 'INCIDENT' };
  const r = (
    await post(u1, 'requests/portal', {
      ...base,
      priority: 'HIGH',
      corporationId: String(own.corporation_id),
      departmentId: String(own.department_id),
    }).expect(201)
  ).body;
  assert.equal(r.requestNo, 1);
  srId = r.id;
  // 다른 사용자(u2)의 부서로는 등록할 수 없다.
  const other = (await get(u2, 'requests/portal').expect(200)).body.scopes[0];
  await post(u1, 'requests/portal', {
    ...base,
    priority: 'LOW',
    corporationId: String(other.corporation_id),
    departmentId: String(other.department_id),
  }).expect(400);
  // u2는 다른 부서의 요청을 목록·상세 어디서도 볼 수 없다.
  const list = (await get(u2, 'requests/portal').expect(200)).body.items;
  assert.ok(!list.some((i) => String(i.id) === srId));
  await get(u2, 'requests/portal/' + srId).expect(404);
  // 고객사 사용자는 담당자 작업함 API를 쓸 수 없다.
  await get(u1, 'requests/desk').expect(403);
});

test('staff are notified and see the request; other workspaces do not', async () => {
  const desk = (await get(admin, 'requests/desk').expect(200)).body;
  const item = desk.items.find((i) => String(i.id) === srId);
  assert.ok(item);
  assert.equal(item.status, 'OPEN');
  assert.ok(desk.assignees.some((a) => a.display_name === 'engineer'));
  for (const who of [admin, engineer]) {
    const n = (await who.agent.get('/api/notifications').expect(200)).body;
    assert.ok(n.unread >= 1 && n.items[0].message.includes('새 요청'));
  }
  const platform = (await get(platformAdmin, 'requests/desk').expect(200)).body;
  assert.ok(!platform.items.some((i) => String(i.id) === srId));
  await get(platformAdmin, 'requests/desk/' + srId).expect(404);
});

test('engineer assigns, answers, keeps internal memo private, and versions guard edits', async () => {
  const d = (await get(engineer, 'requests/desk/' + srId).expect(200)).body;
  version = d.item.version;
  const me = await user('engineer');
  await post(engineer, 'requests/desk/' + srId, {
    version,
    status: 'IN_PROGRESS',
    assigneeId: String(me),
    comment: '확인 중입니다.',
  }).expect(201);
  // 같은 version으로 다시 저장하면 충돌로 거절된다.
  await post(engineer, 'requests/desk/' + srId, { version, comment: '중복' }).expect(409);
  version = (await get(engineer, 'requests/desk/' + srId).expect(200)).body.item.version;
  // 고객 확인 없이 담당자가 바로 종료(CLOSED)할 수는 없다.
  await post(engineer, 'requests/desk/' + srId, { version, status: 'CLOSED' }).expect(400);
  await post(engineer, 'requests/desk/' + srId, {
    version,
    comment: '고객사 방화벽 정책 확인 필요',
    internal: true,
  }).expect(201);
  const view = (await get(u1, 'requests/portal/' + srId).expect(200)).body;
  assert.equal(view.item.status, 'IN_PROGRESS');
  assert.ok(view.events.some((e) => e.body === '확인 중입니다.'));
  assert.ok(!view.events.some((e) => e.internal || e.body === '고객사 방화벽 정책 확인 필요'));
  const n = (await u1.agent.get('/api/notifications').expect(200)).body;
  assert.ok(n.items.some((i) => i.message.includes('답변')));
});

test('only the assignee or a manager changes an assigned request', async () => {
  // 위 테스트에서 engineer가 자기에게 배정했다. 다른 엔지니어는 상태·담당을 못 바꾸고 댓글만 남긴다.
  let v = (await get(engineer2, 'requests/desk/' + srId).expect(200)).body.item.version;
  await post(engineer2, 'requests/desk/' + srId, { version: v, priority: 'URGENT' }).expect(403);
  await post(engineer2, 'requests/desk/' + srId, {
    version: v,
    assigneeId: String(await user('engineer2')),
  }).expect(403);
  await post(engineer2, 'requests/desk/' + srId, {
    version: v,
    comment: '참고: 지난달 같은 증상',
    internal: true,
  }).expect(201);
  // 업체 관리자는 다른 사람에게 재배정할 수 있고, 다시 원래 담당자로 돌려놓는다.
  v = (await get(admin, 'requests/desk/' + srId).expect(200)).body.item.version;
  await post(admin, 'requests/desk/' + srId, {
    version: v,
    assigneeId: String(await user('engineer2')),
  }).expect(201);
  v = (await get(admin, 'requests/desk/' + srId).expect(200)).body.item.version;
  await post(admin, 'requests/desk/' + srId, {
    version: v,
    assigneeId: String(await user('engineer')),
  }).expect(201);
  const list = (await get(engineer2, 'requests/desk').expect(200)).body;
  assert.equal(list.me.manager, false);
  assert.equal((await get(admin, 'requests/desk').expect(200)).body.me.manager, true);
});

test('starting work on an unassigned request assigns the person who started it', async () => {
  const scope = (await get(u1, 'requests/portal').expect(200)).body.scopes[0];
  const created = (
    await post(u1, 'requests/portal', {
      title: '프린터 드라이버 설치',
      body: '새 PC에 설치 부탁드립니다.',
      category: 'REQUEST',
      priority: 'LOW',
      corporationId: String(scope.corporation_id),
      departmentId: String(scope.department_id),
    }).expect(201)
  ).body;
  const v = (await get(engineer2, 'requests/desk/' + created.id).expect(200)).body.item.version;
  // 엔지니어는 미배정 요청을 다른 사람에게 배정할 수 없다.
  await post(engineer2, 'requests/desk/' + created.id, {
    version: v,
    assigneeId: String(await user('engineer')),
  }).expect(403);
  await post(engineer2, 'requests/desk/' + created.id, {
    version: v,
    status: 'IN_PROGRESS',
  }).expect(201);
  const item = (await get(engineer2, 'requests/desk/' + created.id).expect(200)).body.item;
  assert.equal(String(item.assignee_id), String(await user('engineer2')));
});

test('customer confirms a resolved request and closed requests reject changes', async () => {
  version = (await get(engineer, 'requests/desk/' + srId).expect(200)).body.item.version;
  // 처리 완료 전에는 고객이 확인할 수 없다.
  await post(u1, 'requests/portal/' + srId + '/confirm', { version }).expect(409);
  await post(engineer, 'requests/desk/' + srId, { version, status: 'RESOLVED' }).expect(201);
  let item = (await get(u1, 'requests/portal/' + srId).expect(200)).body.item;
  assert.equal(item.status, 'RESOLVED');
  // 재처리 요청 → 담당자 재처리 → 다시 완료 → 고객 확인 순서.
  // 재처리 요청은 사유가 필수이고, 사유는 처리 이력에 고객 댓글로 남는다.
  await post(u1, 'requests/portal/' + srId + '/reopen', { version: item.version }).expect(400);
  await post(u1, 'requests/portal/' + srId + '/reopen', {
    version: item.version,
    reason: '아직 인쇄가 안 됩니다.',
  }).expect(201);
  const reopened = (await get(engineer, 'requests/desk/' + srId).expect(200)).body;
  assert.ok(reopened.events.some((e) => e.body === '재처리 요청 사유: 아직 인쇄가 안 됩니다.'));
  version = (await get(engineer, 'requests/desk/' + srId).expect(200)).body.item.version;
  await post(engineer, 'requests/desk/' + srId, { version, status: 'RESOLVED' }).expect(201);
  item = (await get(u1, 'requests/portal/' + srId).expect(200)).body.item;
  await post(u1, 'requests/portal/' + srId + '/confirm', { version: item.version }).expect(201);
  item = (await get(u1, 'requests/portal/' + srId).expect(200)).body.item;
  assert.equal(item.status, 'CLOSED');
  await post(u1, 'requests/portal/' + srId + '/comment', { body: '추가 문의' }).expect(409);
  await post(engineer, 'requests/desk/' + srId, {
    version: item.version,
    comment: '종료 후 답변',
  }).expect(409);
  // 알림 모두 읽음 처리.
  await post(engineer, 'notifications/read', { ids: [] }).expect(201);
  assert.equal((await engineer.agent.get('/api/notifications').expect(200)).body.unread, 0);
});

test('workspace SLA settings apply to new requests and record first response', async () => {
  const sla = (await get(admin, 'sla').expect(200)).body.items;
  assert.deepEqual(
    sla.map((r) => r.priority),
    ['URGENT', 'HIGH', 'NORMAL', 'LOW'],
  );
  assert.ok(sla.every((r) => !r.custom));
  // 첫 응답 기한이 처리 기한보다 길면 거절, 정상 값은 저장, 같은 행을 버전 없이 다시 만들면 충돌.
  await post(admin, 'sla', {
    rows: [{ priority: 'URGENT', responseHours: 9, resolveHours: 6 }],
  }).expect(409);
  await post(admin, 'sla', {
    rows: [{ priority: 'URGENT', responseHours: 2, resolveHours: 6 }],
  }).expect(201);
  await post(admin, 'sla', {
    rows: [{ priority: 'URGENT', responseHours: 3, resolveHours: 6 }],
  }).expect(409);
  await get(u1, 'sla').expect(403);
  const scope = (await get(u1, 'requests/portal').expect(200)).body.scopes[0];
  const r = (
    await post(u1, 'requests/portal', {
      title: '서버 다운',
      body: '긴급 확인 바랍니다.',
      category: 'INCIDENT',
      priority: 'URGENT',
      corporationId: String(scope.corporation_id),
      departmentId: String(scope.department_id),
    }).expect(201)
  ).body;
  const row = (
    await db.query(
      `SELECT extract(epoch FROM due_at-created_at)/3600 AS resolve,extract(epoch FROM response_due_at-created_at)/3600 AS response,
       first_response_at FROM app.service_requests WHERE id=$1`,
      [r.id],
      ws,
    )
  ).rows[0];
  assert.equal(Math.round(row.resolve), 6);
  assert.equal(Math.round(row.response), 2);
  assert.equal(row.first_response_at, null);
  // 내부 메모는 첫 응답이 아니고, 고객에게 보이는 답변은 첫 응답이다.
  let v = (await get(engineer, 'requests/desk/' + r.id).expect(200)).body.item.version;
  await post(engineer, 'requests/desk/' + r.id, {
    version: v,
    comment: '메모',
    internal: true,
  }).expect(201);
  const first = async () =>
    (await db.query('SELECT first_response_at FROM app.service_requests WHERE id=$1', [r.id], ws))
      .rows[0].first_response_at;
  assert.equal(await first(), null);
  v = (await get(engineer, 'requests/desk/' + r.id).expect(200)).body.item.version;
  await post(engineer, 'requests/desk/' + r.id, { version: v, comment: '확인했습니다.' }).expect(
    201,
  );
  assert.ok(await first());
});

test('monthly report summarizes the current month and exports Excel', async () => {
  const ExcelJS = require('exceljs');
  const month = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 7);
  await get(admin, 'reports/monthly?month=2026-13').expect(400);
  await get(u1, 'reports/monthly?month=' + month).expect(403);
  const report = (await get(admin, 'reports/monthly?month=' + month).expect(200)).body;
  const row = report.rows.find((x) => x.customer_name === prefix);
  // 등록 3건: 확인까지 끝난 1건, 미처리 1건, 담당 규칙 테스트에서 처리 중으로 둔 1건
  assert.equal(row.created, 3);
  assert.equal(row.resolved, 1);
  assert.equal(row.closed, 1);
  assert.equal(row.resolveRate, 100);
  assert.equal(row.open_now, 2);
  assert.equal(report.total.created, row.created);
  // 다른 업체의 고객사는 리포트에 나오지 않는다.
  const platformReport = (await get(platformAdmin, 'reports/monthly?month=' + month).expect(200))
    .body;
  assert.ok(!platformReport.rows.some((x) => x.customer_name === prefix));
  const file = await get(admin, 'reports/monthly.xlsx?month=' + month)
    .buffer(true)
    .parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    })
    .expect(200)
    .expect('Content-Type', /spreadsheetml/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file.body);
  assert.deepEqual(
    wb.worksheets.map((w) => w.name),
    ['요약', '요청 목록'],
  );
  const list = wb.getWorksheet('요청 목록');
  assert.equal(list.rowCount, 1 + 3);
  assert.equal(list.getRow(2).getCell(5).value, 'VPN 접속 불가');
});
