/**
 * 메일 발송 검증. 이 PC 안에서만 동작하는 가짜 메일 서버(SMTP)를 띄우고 SMTP_HOST를 그곳으로 지정해 실제 메일은 나가지 않는다.
 * 확인 내용: 고객 요청 단계별 업무 메일의 받는 사람(관리자·담당자·요청자·직원), 이메일 미인증 계정 제외,
 * 링크 재발급이 업무 메일을 지우지 않음, 발송 후 내용 삭제, 일시 오류 재시도·영구 오류 중단과 운영 경보.
 * _test DB에서만 실행한다.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const request = require('supertest');
const argon2 = require('argon2');
const crypto = require('node:crypto');
const prefix = 'mail_' + crypto.randomBytes(4).toString('hex');
const password = 'Mail test password 123!';
const inbox = [];
// fail: 다음 메일들에 돌려줄 오류 응답 코드(예: 451 일시 오류, 550 영구 오류). 0이면 정상 접수.
const smtp = { fail: 0 };
let server, app, db, settings, mail, ws, admin, engineer, u1, alerts;

/** 가짜 SMTP 서버. 받은 메일을 inbox에 { to, data }로 쌓는다. 인증·암호화 없이 기본 명령만 처리한다. */
function startSmtp() {
  server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    let buf = '',
      inData = false,
      msg = { to: [], data: '' };
    const say = (line) => sock.write(line + '\r\n');
    say('220 fake-smtp');
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line !== '.') {
            msg.data += line + '\n';
            continue;
          }
          inData = false;
          if (smtp.fail) say(smtp.fail + ' rejected for test');
          else {
            inbox.push(msg);
            say('250 queued');
          }
          msg = { to: [], data: '' };
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'RCPT') msg.to.push(/<([^>]+)>/.exec(line)?.[1]);
        if (cmd === 'DATA') {
          inData = true;
          say('354 go ahead');
        } else if (cmd === 'QUIT') {
          say('221 bye');
          sock.end();
        } else say('250 ok');
      }
    });
    sock.on('error', () => undefined);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
  );
}
/** 메일 본문 해독. nodemailer는 한글 본문을 quoted-printable 또는 base64로 바꿔 보낸다. */
function bodyOf(m) {
  const [head, ...rest] = m.data.split('\n\n');
  const raw = rest.join('\n\n');
  if (/Content-Transfer-Encoding: base64/i.test(head))
    return Buffer.from(raw.replace(/\s/g, ''), 'base64').toString('utf8');
  if (/Content-Transfer-Encoding: quoted-printable/i.test(head))
    return Buffer.from(
      raw
        .replace(/=\n/g, '')
        .replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))),
      'latin1',
    ).toString('utf8');
  return raw;
}
const addr = (name) => `${prefix}.${name}@example.test`;
const mailsTo = (name) => inbox.filter((m) => m.to.includes(addr(name))).map(bodyOf);
const post = (who, url, data, menu = who.menu) =>
  who.agent
    .post('/api/' + url)
    .set('Origin', settings.origin)
    .set('X-CSRF-Token', who.csrf)
    .set('X-Menu-ID', menu)
    .send(data);
const get = (who, url) => who.agent.get('/api/' + url).set('X-Menu-ID', who.menu);
async function login(loginId, screen) {
  const agent = request.agent(app.getHttpServer());
  const who = { agent, csrf: (await agent.get('/api/auth/csrf').expect(200)).body.csrfToken };
  who.csrf = (await post(who, 'auth/login', { loginId, password }, '0').expect(201)).body.csrfToken;
  const nav = (await agent.get('/api/navigation').expect(200)).body;
  who.menu = nav.screens.find((s) => s.code === screen)?.menu_id;
  assert.ok(who.menu, loginId + ' must see ' + screen);
  return who;
}
const userId = async (name) =>
  String(
    (await db.query('SELECT id FROM app.users WHERE login_id=$1', [prefix + '_' + name], ws))
      .rows[0].id,
  );
const outbox = async (name) =>
  (
    await db.query(
      `SELECT m.* FROM app.mail_outbox m JOIN app.users u ON u.id=m.user_id WHERE u.login_id=$1 ORDER BY m.id`,
      [prefix + '_' + name],
      ws,
    )
  ).rows;

before(async () => {
  if (!process.env.PGDATABASE?.endsWith('_test')) throw Error('Isolated DB required');
  // 설정 파일(config.ts)은 처음 불러올 때 환경변수를 읽으므로, 가짜 메일 서버 주소를 먼저 넣고 불러온다.
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(await startSmtp());
  process.env.SMTP_USER = '';
  process.env.MAIL_FROM = 'Doneline 알림 <noti@example.test>';
  const { createApp } = require('../dist/app');
  const { Db } = require('../dist/db');
  const { Mail } = require('../dist/mail');
  const { Notifier } = require('../dist/notifier');
  settings = require('../dist/config').settings;
  app = await createApp();
  db = app.get(Db);
  mail = app.get(Mail);
  // 운영 경보를 슬랙 대신 배열에 모은다(같은 인스턴스를 mail.ts도 쓴다).
  alerts = [];
  app.get(Notifier).alert = (_key, text) => alerts.push(text);
  db.useScriptWorkspace(await db.platformWorkspaceId());
  await db.query('DELETE FROM app.login_limits');
  // 이전 실행이 남긴 다른 업체의 대기 메일도 가짜 서버로 함께 나갈 수 있다. 그래서 결과는 이 테스트의 주소(prefix)로만 판단한다.
  const hash = await argon2.hash(password);
  ws = String(
    (await db.query('SELECT app.create_workspace($1,$2) AS id', [prefix.replace('_', '-'), prefix]))
      .rows[0].id,
  );
  await db.tx(async (c) => {
    const resp = async (code) =>
      (await c.query('SELECT id FROM app.responsibilities WHERE code=$1', [code])).rows[0].id;
    const customer = (
      await c.query('INSERT INTO app.customers(code,name) VALUES($1,$2) RETURNING id', [
        prefix,
        '테스트고객사',
      ])
    ).rows[0].id;
    const corp = (
      await c.query(
        "INSERT INTO app.corporations(customer_id,code,name) VALUES($1,'C1','법인1') RETURNING id",
        [customer],
      )
    ).rows[0].id;
    const dept = (
      await c.query(
        "INSERT INTO app.departments(customer_id,corporation_id,code,name) VALUES($1,$2,'D1','부서1') RETURNING id",
        [customer, corp],
      )
    ).rows[0].id;
    // verified=false인 계정은 이메일은 있지만 인증을 마치지 않은 상태다(업무 메일 제외 대상).
    const add = async (name, respCode, customerId, verified = true) =>
      (
        await c.query(
          `INSERT INTO app.users(login_id,password_hash,display_name,resp_id,must_change_password,customer_id,email,email_verified_at)
           VALUES($1,$2,$3,$4,false,$5,$6,CASE WHEN $7 THEN now() END) RETURNING id`,
          [prefix + '_' + name, hash, name, await resp(respCode), customerId, addr(name), verified],
        )
      ).rows[0].id;
    await add('admin', 'WORKSPACE_ADMIN', null);
    await add('engineer', 'WORKSPACE_ENGINEER', null);
    await add('unverified', 'WORKSPACE_ENGINEER', null, false);
    const u = await add('u1', 'CUSTOMER_USER', customer);
    await c.query(
      'INSERT INTO app.user_corporations(customer_id,user_id,corporation_id) VALUES($1,$2,$3)',
      [customer, u, corp],
    );
    await c.query(
      'INSERT INTO app.user_scopes(customer_id,user_id,corporation_id,department_id) VALUES($1,$2,$3,$4)',
      [customer, u, corp, dept],
    );
  }, ws);
  admin = await login(prefix + '_admin', 'SR_DESK');
  engineer = await login(prefix + '_engineer', 'SR_DESK');
  u1 = await login(prefix + '_u1', 'SR_PORTAL');
});
after(async () => {
  await app?.close();
  server?.close();
});

test('request steps send mail to the decided recipients only', async () => {
  const scope = (await get(u1, 'requests/portal').expect(200)).body.scopes[0];
  const created = (
    await post(u1, 'requests/portal', {
      title: '프린터 고장',
      body: '비밀 본문: 3층 프린터가 안 됩니다.',
      category: 'INCIDENT',
      priority: 'NORMAL',
      corporationId: String(scope.corporation_id),
      departmentId: String(scope.department_id),
    }).expect(201)
  ).body;
  const id = created.id;
  const version = async () =>
    (await get(admin, 'requests/desk/' + id).expect(200)).body.item.version;
  await mail.flush();
  // 새 요청: 업체 관리자만 받는다(엔지니어·요청자 본인은 받지 않음).
  const toAdmin = mailsTo('admin');
  assert.equal(toAdmin.length, 1);
  assert.match(toAdmin[0], /새 요청이 등록되었습니다/);
  assert.ok(toAdmin[0].includes(`${settings.origin}/?request=${id}`));
  // 메일에는 요청 본문을 넣지 않는다.
  assert.ok(!toAdmin[0].includes('비밀 본문'));
  assert.equal(mailsTo('engineer').length, 0);
  assert.equal(mailsTo('u1').length, 0);
  // 보낸 메일은 SENT로 바뀌고 내용이 지워진다.
  const sent = (await outbox('admin')).at(-1);
  assert.equal(sent.status, 'SENT');
  assert.equal(sent.kind, 'REQUEST');
  assert.equal(sent.payload, '');
  assert.ok(sent.sent_at);

  // 관리자가 엔지니어에게 맡겨 처리 시작: 담당자와 요청자가 받는다.
  await post(admin, 'requests/desk/' + id, {
    version: await version(),
    action: 'START',
    assigneeId: await userId('engineer'),
  }).expect(201);
  await mail.flush();
  assert.match(mailsTo('engineer').at(-1), /담당자로 지정되었습니다/);
  assert.match(mailsTo('u1').at(-1), /처리를 시작했습니다/);
  assert.equal(mailsTo('admin').length, 1);

  // 처리 완료: 요청자만 받는다.
  await post(engineer, 'requests/desk/' + id, {
    version: await version(),
    action: 'RESOLVE',
  }).expect(201);
  await mail.flush();
  assert.match(mailsTo('u1').at(-1), /처리가 완료되었습니다/);
  assert.equal(mailsTo('engineer').length, 1);

  // 고객의 재처리 요청: 담당자가 받는다.
  await post(u1, `requests/portal/${id}/reopen`, {
    version: await version(),
    reason: '여전히 안 됩니다',
  }).expect(201);
  await mail.flush();
  assert.match(mailsTo('engineer').at(-1), /재처리를 요청했습니다/);

  // 되돌리기: 다시 맡을 업체 직원이 받는다. 이메일 미인증 직원은 제외된다. 고객은 받지 않는다.
  const u1Before = mailsTo('u1').length;
  await post(engineer, 'requests/desk/' + id, {
    version: await version(),
    action: 'REVERT',
    comment: '담당 조정',
  }).expect(201);
  await mail.flush();
  assert.match(mailsTo('admin').at(-1), /다시 배정이 필요합니다/);
  assert.equal(mailsTo('unverified').length, 0);
  assert.equal(mailsTo('u1').length, u1Before);

  // 요청 취소: 요청자가 받는다.
  await post(admin, 'requests/desk/' + id, {
    version: await version(),
    action: 'CANCEL',
    comment: '전화로 취소 요청',
  }).expect(201);
  await mail.flush();
  assert.match(mailsTo('u1').at(-1), /요청이 취소되었습니다/);
});

test('issuing a new password link keeps pending request mail', async () => {
  const scope = (await get(u1, 'requests/portal').expect(200)).body.scopes[0];
  await post(u1, 'requests/portal', {
    title: '메일 유지 확인',
    body: '본문',
    category: 'REQUEST',
    priority: 'LOW',
    corporationId: String(scope.corporation_id),
    departmentId: String(scope.department_id),
  }).expect(201);
  // 아직 보내기 전(HELD)에 관리자 본인의 비밀번호 링크를 다시 만든다.
  const me = (
    await db.query('SELECT id,version FROM app.users WHERE login_id=$1', [prefix + '_admin'], ws)
  ).rows[0];
  const users = await login(prefix + '_admin', 'USER_REGISTER');
  const r = (
    await post(users, 'accounts/password-link', {
      userId: String(me.id),
      version: me.version,
    }).expect(201)
  ).body;
  assert.equal(r.mailed, true);
  const pending = (await outbox('admin')).filter((m) => m.status === 'HELD');
  assert.deepEqual(pending.map((m) => m.kind).sort(), ['ACCOUNT', 'REQUEST']);
  await mail.flush();
  const recent = mailsTo('admin').slice(-2).join('\n');
  assert.match(recent, /메일 유지 확인/);
  assert.match(recent, /#account=PASSWORD:/);
});

test('temporary failures retry with backoff, permanent ones stop and alert ops', async () => {
  // 실패를 시험할 메일을 하나 만든다(요청 등록 → 관리자에게 새 요청 메일).
  const scope = (await get(u1, 'requests/portal').expect(200)).body.scopes[0];
  const create = (title) =>
    post(u1, 'requests/portal', {
      title,
      body: '본문',
      category: 'REQUEST',
      priority: 'LOW',
      corporationId: String(scope.corporation_id),
      departmentId: String(scope.department_id),
    }).expect(201);
  await create('일시 오류 확인');
  smtp.fail = 451;
  await mail.flush();
  let m = (await outbox('admin')).at(-1);
  assert.equal(m.status, 'HELD');
  assert.equal(m.attempts, 1);
  assert.equal(m.last_error, 'SMTP 451');
  assert.ok(new Date(m.next_attempt_at) > new Date(), 'next attempt is delayed');
  // 기다리는 대신 다음 시도 시각을 당겨 가며 한도(5회)까지 실패시킨다.
  for (let i = 0; i < 4; i++) {
    await db.query('UPDATE app.mail_outbox SET next_attempt_at=now() WHERE id=$1', [m.id], ws);
    await mail.flush();
  }
  m = (await outbox('admin')).find((x) => x.id === m.id);
  assert.equal(m.status, 'FAILED');
  assert.equal(m.attempts, 5);
  assert.equal(m.payload, '');
  assert.ok(alerts.some((t) => t.includes('보내지 못했습니다')));

  // 550(주소 없음 등 영구 오류)은 다시 시도하지 않고 바로 멈춘다.
  await create('영구 오류 확인');
  smtp.fail = 550;
  await mail.flush();
  m = (await outbox('admin')).at(-1);
  assert.equal(m.status, 'FAILED');
  assert.equal(m.attempts, 1);
  smtp.fail = 0;
});

test('ops alerts of the same kind are sent once per window with a skipped count', async () => {
  const { Notifier } = require('../dist/notifier');
  const n = new Notifier();
  const sent = [];
  n.ops = async (text) => void sent.push(text);
  n.alert('error:GET /x', '서버 오류 1');
  n.alert('error:GET /x', '서버 오류 2');
  n.alert('error:GET /y', '다른 화면 오류');
  assert.deepEqual(sent, ['서버 오류 1', '다른 화면 오류']);
  // 10분이 지난 것처럼 기록을 당기면 다시 보내며 생략한 횟수를 붙인다.
  n.recent.get('error:GET /x').at -= 11 * 60 * 1000;
  n.alert('error:GET /x', '서버 오류 3');
  assert.match(sent.at(-1), /서버 오류 3 \(지난 경보 이후 같은 경보 1건 생략\)/);
});
