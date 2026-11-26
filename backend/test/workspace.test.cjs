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
let app,
  db,
  platform,
  other,
  root,
  sharedResp,
  platformCustomer,
  otherCustomer,
  otherAdmin,
  platformAdmin;

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
  root = (await db.query("SELECT root_menu_id FROM app.responsibilities WHERE code='ADMIN'"))
    .rows[0].root_menu_id;
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
    await db.query(
      'INSERT INTO app.customers(code,name) VALUES($1,$1) RETURNING id',
      [prefix],
      other,
    )
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

// RLS를 걸지 않는 표와 그 이유. 새 표를 만들고 RLS를 빠뜨리면 아래 검사가 실패하므로,
// 정말 업체 구분이 필요 없는 표일 때만 이유와 함께 여기에 추가한다(설계문서 '워크스페이스 분리' 참고).
const NO_RLS = {
  'app.auth_sessions':
    '추측 불가능한 토큰 해시로만 찾고, 로그인 후 workspace_id를 기록해 요청 처리에 쓴다',
  'app.authorization_state': '권한 캐시 무효화용 전역 버전 번호 한 줄',
  'app.login_limits': '로그인 전 시도 횟수 제한(IP·아이디 해시), 업체가 정해지기 전에 쓴다',
  'app.menus': '모든 업체가 함께 쓰는 공통 메뉴 구성(운영 워크스페이스만 수정)',
  'app.menu_edges': '공통 메뉴 구성',
  'app.menu_screens': '공통 메뉴 구성',
  'app.menu_screen_buttons': '공통 메뉴 구성',
  'app.screens': '공통 화면 목록',
  'app.screen_buttons': '공통 화면 버튼 목록',
};

test('every table the app role can reach has row level security or a stated reason', async () => {
  // DB 목록(pg_class=표·뷰 목록, pg_namespace=스키마)에서 앱 계정이 어떤 권한이라도 가진 표·뷰를 모은다.
  // 앱 계정으로 접속해 읽으므로 '앱이 실제로 만질 수 있는 것'만 검사 대상이 된다.
  const { rows } = await db.query(`
    SELECT n.nspname||'.'||c.relname AS name, c.relkind AS kind, c.relrowsecurity AS rls,
           pg_has_role(current_user,c.relowner,'MEMBER') AS owned,
           COALESCE('security_invoker=true'=ANY(c.reloptions),false) AS invoker,
           (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname=n.nspname AND p.tablename=c.relname) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE c.relkind IN ('r','p','v') AND n.nspname IN ('app','audit')
       AND has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE')`);
  // 앱 계정이 슈퍼유저·RLS 우회 권한을 가지거나 표 소유자(또는 소유자 역할의 구성원, pg_has_role MEMBER)이면
  // 정책이 적용되지 않는다(소유자는 기본적으로 RLS를 건너뜀).
  const role = (
    await db.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user')
  ).rows[0];
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  assert.deepEqual(
    rows.filter((r) => r.owned).map((r) => r.name),
    [],
  );
  // 뷰는 기본이 '만든 사람 권한'이라 RLS를 우회한다. security_invoker 뷰만 허용한다.
  assert.deepEqual(
    rows.filter((r) => r.kind === 'v' && !r.invoker).map((r) => r.name),
    [],
  );
  // 표는 RLS 켜짐 + 정책 1개 이상이어야 한다(켜기만 하고 정책이 없으면 앱이 아무 행도 못 쓴다).
  const missing = rows
    .filter((r) => r.kind !== 'v' && !(r.rls && r.policies > 0) && !NO_RLS[r.name])
    .map((r) => r.name);
  assert.deepEqual(missing, [], 'RLS 정책이 없는 표: 정책을 만들거나 NO_RLS에 이유를 적는다');
  // 조건이 그냥 true인 정책은 '정책 있음'으로 보여도 모든 업체 행을 연다. 그런 정책이 없어야 한다.
  // (qual=조회·수정·삭제 대상 조건, with_check=새로 쓰는 행의 조건, INSERT 정책은 qual이 비어 있음)
  const open = (
    await db.query(`SELECT schemaname||'.'||tablename||' '||policyname AS name FROM pg_policies
      WHERE schemaname IN ('app','audit') AND (qual='true' OR with_check='true')`)
  ).rows.map((r) => r.name);
  assert.deepEqual(open, []);
  // 예외 목록에 지워진 표 이름이 남지 않게 한다.
  const names = new Set(rows.map((r) => r.name));
  assert.deepEqual(
    Object.keys(NO_RLS).filter((n) => !names.has(n)),
    [],
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
  // 형식 오류는 어느 칸이 틀렸는지 한국어로 알려 준다(영문 'Bad Request Exception' 금지).
  const bad = await post(guest, 'workspaces/signup', { ...body, workspaceCode: 'Bad Code' }).expect(
    400,
  );
  assert.match(bad.body.message, /업체 코드/);
  const earlyBefore = (await db.query('SELECT app.early_adopter_count() AS n')).rows[0].n;
  await post(guest, 'workspaces/signup', body).expect(201);
  // 초기 업체 내부 기록: 기록된 업체가 30곳 미만이었으면 이번 업체가 초기 업체가 되고 수가 1 늘어난다.
  const earlyAfter = (await db.query('SELECT app.early_adopter_count() AS n')).rows[0].n;
  assert.equal(earlyAfter, earlyBefore < 30 ? earlyBefore + 1 : earlyBefore);
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
  // 시작하기 현황: 새 업체는 고객사가 없고 직원은 관리자 1명이다.
  const start = (await admin.agent.get('/api/workspaces/onboarding').expect(200)).body;
  assert.equal(start.customers, 0);
  assert.equal(start.staff, 1);
  // 직원을 등록하면 메일 발송 없이도 전달할 수 있도록 비밀번호 설정 링크를 돌려준다.
  const engineer = (
    await admin.agent.get('/api/accounts/options').set('X-Menu-ID', userMenu).expect(200)
  ).body.responsibilities.find((r) => r.code === 'WORKSPACE_ENGINEER');
  const created = (
    await post(
      admin,
      'accounts',
      {
        customerId: null,
        loginId: prefix + '_eng',
        name: '엔지니어',
        address: '',
        mobile: '010-0000-0000',
        email: prefix + '_eng@example.com',
        respId: engineer.id,
      },
      userMenu,
    ).expect(201)
  ).body;
  assert.match(created.link, /#account=PASSWORD:[a-f0-9]{64}$/);
  assert.equal((await admin.agent.get('/api/workspaces/onboarding').expect(200)).body.staff, 2);
});

test('feedback goes to the platform inbox only', async () => {
  const title = prefix + ' 엑셀 양식 추가 요청';
  await post(otherAdmin, 'feedback', { kind: 'WRONG', title, body: 'x' }).expect(400);
  await post(otherAdmin, 'feedback', {
    kind: 'IMPROVEMENT',
    title,
    body: '월간 리포트에 고객사 로고를 넣고 싶습니다.',
    page: '월간 리포트',
  }).expect(201);
  // 운영 워크스페이스가 아니면 메뉴가 있어도 수신함을 볼 수 없고, DB에서도 보이지 않는다.
  await get(otherAdmin, 'feedback').expect(403);
  assert.equal(
    (await db.query('SELECT count(*)::int n FROM app.feedback', [], other)).rows[0].n,
    0,
  );
  const items = (await get(platformAdmin, 'feedback').expect(200)).body.items;
  const item = items.find((i) => i.title === title);
  assert.equal(item.workspace_name, prefix);
  assert.equal(item.user_name, prefix + '_other');
  assert.equal(item.status, 'NEW');
  await post(platformAdmin, 'feedback/' + item.id + '/status', {
    status: 'PLANNED',
    version: item.version,
  }).expect(201);
  await post(platformAdmin, 'feedback/' + item.id + '/status', {
    status: 'DONE',
    version: item.version,
  }).expect(409);
});
