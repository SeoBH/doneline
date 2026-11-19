/**
 * 시연용 예시 데이터 만들기. 시연 전용 DB(doneline_demo)를 지우고 새로 만든 뒤
 * 가상의 업체 '한빛IT서비스'와 고객사 5곳, 직원 4명, 고객 사용자 6명, 운영 워크스페이스의 서비스 운영자 1명, 최근 3개월 치 요청 약 60건을 넣는다.
 * 요청은 실제 API(등록 → 처리 시작 → 답변·내부 메모 → 처리 완료 → 고객 확인)로 만들어 상태 규칙·알림·감사 기록이
 * 실제 사용과 같게 남고, 마지막에 관리 계정으로 날짜만 과거로 옮겨 목록·월간 리포트가 자연스럽게 채워지게 한다.
 *
 * 사용: npm run demo:seed  (빌드 후. scripts/demo.ps1 -Sample이 시작할 때마다 자동으로 실행한다)
 * 준비: 루트 .env(앱 계정)·.env.db-admin(DB 관리 계정).
 * 부수 효과:
 *  - doneline_demo DB 재생성(다른 DB에는 영향 없음). 메일·슬랙은 보내지 않는다.
 *  - 루트 .env.demo에 시연 계정 목록과 이번에 새로 만든 비밀번호를 쓴다(저장소에 올리지 않는 파일).
 *    서버는 시연 모드에서 이 목록을 로그인 화면의 '시연 계정' 창으로 보여 준다(config.ts demoAccounts).
 */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const DB = 'doneline_demo';

// 앱이 설정을 읽기 전에 시연 DB를 지정하고 메일·슬랙을 끈다(.env보다 이 값이 우선한다).
process.env.PGDATABASE = DB;
process.env.SLACK_WEBHOOK_URL = '';
process.env.SMTP_HOST = '';
process.env.DEMO_ACCOUNTS = '';
// scripts/demo.ps1은 서버용 운영 설정(NODE_ENV=production·HTTPS 출처·중계 표식)을 먼저 넣고 이 스크립트를 부른다.
// 이 스크립트는 같은 프로세스 안에서 http로 API를 부르므로 일반 개발 설정으로 되돌린다(보안 쿠키·중계 표식 검사 끔).
process.env.NODE_ENV = 'development';
process.env.APP_ORIGIN = 'http://127.0.0.1:3000';
process.env.TRUST_PROXY = '0';
process.env.PROXY_SECRET = '';

// 다시 만들 때마다 새 비밀번호를 쓴다. 로그인 화면에 공개되는 값이라 외울 필요는 없고,
// 지난 시연에서 본 사람이 다음 시연 때 미리 들어와 데이터를 바꾸지 못하게 한다.
const password = 'Demo-' + crypto.randomBytes(3).toString('hex') + '!';

const admin = require('dotenv').parse(fs.readFileSync(path.join(root, '.env.db-admin')));
const pgConfig = (database) => ({
  host: admin.PGHOST,
  port: Number(admin.PGPORT || 5432),
  user: admin.PGUSER,
  password: admin.PGPASSWORD,
  database,
});

/** DB 관리 계정으로 시연 DB를 지우고 새로 만든 뒤 번호순 마이그레이션을 적용한다. */
async function resetDb() {
  const { Client } = require('pg');
  const c = new Client(pgConfig('postgres'));
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${DB}`);
  await c.end();
  execFileSync('node', ['backend/migrate.cjs'], {
    cwd: root,
    env: { ...process.env, ...admin, PGDATABASE: DB },
    stdio: 'ignore',
  });
}

// ── 예시 데이터 정의 ─────────────────────────────────────────────
// 고객사 → 법인 → 부서. 고객 사용자는 [아이디, 이름, 법인 코드, 부서 코드].
const CUSTOMERS = [
  {
    code: 'SML',
    name: '서울메디랩',
    corps: [
      {
        code: 'SML',
        name: '(주)서울메디랩',
        depts: [
          ['ADM', '경영지원팀'],
          ['LAB', '연구소'],
        ],
      },
    ],
    users: [
      ['sml_lee', '이지은', 'SML', 'ADM'],
      ['sml_choi', '최도윤', 'SML', 'LAB'],
    ],
  },
  {
    code: 'GRN',
    name: '그린물산',
    corps: [
      {
        code: 'GRN',
        name: '그린물산(주)',
        depts: [
          ['SAL', '영업팀'],
          ['FIN', '재무팀'],
        ],
      },
      { code: 'GLG', name: '그린로지스(주)', depts: [['OPS', '물류운영팀']] },
    ],
    users: [
      ['grn_jung', '정하늘', 'GRN', 'SAL'],
      ['grn_oh', '오세훈', 'GLG', 'OPS'],
    ],
  },
  {
    code: 'DHP',
    name: '대한정밀',
    corps: [{ code: 'DHP', name: '대한정밀(주)', depts: [['PRD', '생산관리팀']] }],
    users: [['dhp_han', '한유진', 'DHP', 'PRD']],
  },
  {
    code: 'MRE',
    name: '미래교육재단',
    corps: [{ code: 'MRE', name: '(재)미래교육재단', depts: [['EDU', '교육사업팀']] }],
    users: [['mre_yoon', '윤서연', 'MRE', 'EDU']],
  },
  {
    code: 'BRN',
    name: '바른회계법인',
    corps: [{ code: 'BRN', name: '바른회계법인', depts: [['AUD', '감사본부']] }],
    users: [],
  },
];
// 업체 직원. [아이디, 이름, 역할]
const STAFF = [
  ['demo_admin', '김한빛', 'WORKSPACE_ADMIN'],
  ['demo_kim', '김지훈', 'WORKSPACE_ENGINEER'],
  ['demo_lee', '이수진', 'WORKSPACE_ENGINEER'],
  ['demo_park', '박민호', 'WORKSPACE_ENGINEER'],
];
// 로그인 화면 '시연 계정' 창에 보여 줄 계정(역할별 대표 1명씩).
const SHOWN = [
  ['서비스 운영자', 'demo_ops', '메뉴·버튼 권한(RESP) 편집 · 업체 데이터는 안 보임'],
  ['업체 관리자', 'demo_admin', '김한빛 · 요청 배정, 월간 리포트, 고객사·사용자 관리'],
  ['업체 담당자', 'demo_kim', '김지훈 · 맡은 요청 처리'],
  ['고객 사용자', 'sml_lee', '서울메디랩 이지은 · 요청 등록·확인'],
  ['고객 사용자', 'grn_jung', '그린물산 정하늘 · 요청 등록·확인'],
];
/**
 * 메뉴 트리 예시. 기본 메뉴는 역할마다 최상위 메뉴 하나에 화면이 바로 달린 1단이라, 시연에서 메뉴 아래에
 * 메뉴를 붙이는 구조(app.menu_edges)가 보이도록 업체 관리자·서비스 운영자 메뉴를 2~3단으로 나눈다.
 * - 업체 관리: 요청 업무 / 기준정보 > 고객사 구조(3단) / 설정
 * - 운영 관리(ROOT): 업무 / 시스템 구성 + 업체 관리와 같은 '기준정보'·'설정' 메뉴를 함께 붙인다(공유 메뉴).
 * 화면은 menu_screens 행의 메뉴만 바꿔 옮기므로 버튼 허용(menu_screen_buttons)이 그대로 유지된다.
 * c: 시연 DB 관리 계정 연결(트랜잭션 안). 공통 구성 표는 앱 계정으로 직접 바꾸지 않는다.
 */
async function nestMenus(c) {
  const menuId = async (code, name) =>
    (
      await c.query(
        'INSERT INTO app.menus(code,name) VALUES($1,$2) ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name RETURNING id',
        [code, name],
      )
    ).rows[0].id;
  const edge = (parent, child, sort) =>
    c.query(
      'INSERT INTO app.menu_edges(parent_menu_id,child_menu_id,sort_order) VALUES($1,$2,$3)',
      [parent, child, sort],
    );
  // 상위 메뉴(from)에 달린 화면들을 하위 메뉴(to)로 옮긴다. 표시 순서는 목록 순서대로 다시 매긴다.
  const move = async (from, to, codes) => {
    for (const [i, code] of codes.entries())
      await c.query(
        `UPDATE app.menu_screens SET menu_id=$2, sort_order=$4
         WHERE menu_id=$1 AND screen_id=(SELECT id FROM app.screens WHERE code=$3)`,
        [from, to, code, i + 1],
      );
  };
  // 공유 메뉴로 대신하는 화면은 원래 자리에서 뺀다(버튼 허용 → 화면 연결 순서로 지운다).
  const drop = async (from, codes) => {
    const where = 'menu_id=$1 AND screen_id IN (SELECT id FROM app.screens WHERE code=ANY($2))';
    await c.query(
      `DELETE FROM app.menu_screen_buttons WHERE menu_screen_id IN (SELECT id FROM app.menu_screens WHERE ${where})`,
      [from, codes],
    );
    await c.query(`DELETE FROM app.menu_screens WHERE ${where}`, [from, codes]);
  };
  const wsRoot = await menuId('WORKSPACE_ADMIN_ROOT', '업체 관리');
  const work = await menuId('DEMO_WS_WORK', '요청 업무');
  const master = await menuId('DEMO_MASTER', '기준정보');
  const customer = await menuId('DEMO_CUSTOMER_TREE', '고객사 구조');
  const settings = await menuId('DEMO_SETTINGS', '설정');
  await move(wsRoot, work, ['SR_DESK', 'SR_REPORT']);
  await move(wsRoot, customer, [
    'CUSTOMER_REGISTER',
    'CORPORATION_REGISTER',
    'DEPARTMENT_REGISTER',
  ]);
  await move(wsRoot, master, ['USER_REGISTER']);
  await move(wsRoot, settings, ['SLA_SETTINGS', 'AUDIT']);
  await edge(wsRoot, work, 1);
  await edge(wsRoot, master, 2);
  await edge(master, customer, 0);
  await edge(wsRoot, settings, 3);

  const opsRoot = await menuId('ROOT', '운영 관리');
  const opsWork = await menuId('DEMO_OPS_WORK', '업무');
  const config = await menuId('DEMO_OPS_CONFIG', '시스템 구성');
  await move(opsRoot, opsWork, ['SR_DESK', 'SR_REPORT', 'FEEDBACK_INBOX']);
  await move(opsRoot, config, ['SCREEN_REGISTER', 'MENU_REGISTER', 'RESP_REGISTER']);
  await drop(opsRoot, [
    'USER_REGISTER',
    'CUSTOMER_REGISTER',
    'CORPORATION_REGISTER',
    'DEPARTMENT_REGISTER',
    'SLA_SETTINGS',
    'AUDIT',
  ]);
  await edge(opsRoot, opsWork, 1);
  await edge(opsRoot, config, 2);
  await edge(opsRoot, master, 3);
  await edge(opsRoot, settings, 4);
}
// 요청 예시 문장. [분류, 제목, 내용, 처리 답변]
const TEMPLATES = [
  [
    'INCIDENT',
    '그룹웨어 로그인이 안 됩니다',
    '오늘 아침부터 그룹웨어에 로그인하면 "세션 만료" 화면만 나옵니다.',
    '세션 서버를 재시작했습니다. 다시 로그인해 보시겠어요?',
  ],
  [
    'INCIDENT',
    '전자결재 첨부파일이 열리지 않습니다',
    '결재 문서의 PDF 첨부를 누르면 빈 화면이 뜹니다.',
    '파일 서버 권한 설정을 바로잡았습니다.',
  ],
  [
    'INCIDENT',
    '사내 VPN 접속 불가',
    '재택 근무 중인데 VPN 연결이 30초 후 끊깁니다.',
    'VPN 장비 인증서를 갱신했습니다.',
  ],
  [
    'INCIDENT',
    '프린터 출력이 대기열에서 멈춥니다',
    '3층 복합기로 보낸 문서가 대기열에서 넘어가지 않습니다.',
    '프린터 스풀러를 정리하고 드라이버를 다시 설치했습니다.',
  ],
  [
    'INCIDENT',
    'ERP 재고 화면 조회가 느립니다',
    '재고 현황 조회에 1분 이상 걸립니다.',
    '조회 쿼리의 인덱스를 추가해 3초 안으로 줄였습니다.',
  ],
  [
    'INCIDENT',
    '홈페이지 문의 게시판 오류',
    '고객 문의 등록 버튼을 누르면 500 오류가 납니다.',
    '게시판 첨부 용량 설정 오류를 고쳤습니다.',
  ],
  [
    'REQUEST',
    '신규 입사자 계정 생성 요청',
    '다음 주 월요일 입사자 2명의 메일·그룹웨어 계정을 만들어 주세요.',
    '계정 2개를 만들고 초기 비밀번호를 담당자께 전달했습니다.',
  ],
  [
    'REQUEST',
    '퇴사자 계정 잠금 요청',
    '이번 달 말 퇴사자의 계정을 잠가 주세요.',
    '말일 18시에 잠금 처리되도록 예약했습니다.',
  ],
  [
    'REQUEST',
    '공유 폴더 권한 추가',
    '영업팀 공유 폴더에 신규 인원 읽기 권한을 추가해 주세요.',
    '권한을 추가했습니다.',
  ],
  [
    'REQUEST',
    '월간 매출 보고서 양식 수정',
    '보고서에 지점별 합계 열을 추가해 주세요.',
    '양식에 지점별 합계를 추가해 배포했습니다.',
  ],
  [
    'REQUEST',
    '노트북 백신 설치 요청',
    '새로 받은 노트북 3대에 백신을 설치해 주세요.',
    '원격으로 설치를 마쳤습니다.',
  ],
  [
    'REQUEST',
    '메일 수신 용량 증설',
    '대표 메일함 용량이 90%를 넘었습니다.',
    '메일함 용량을 두 배로 늘렸습니다.',
  ],
  [
    'QUESTION',
    '비밀번호 변경 주기 문의',
    '그룹웨어 비밀번호를 몇 달마다 바꿔야 하나요?',
    '현재 정책은 90일입니다. 만료 7일 전에 안내가 나갑니다.',
  ],
  [
    'QUESTION',
    '백업 보관 기간 문의',
    '서버 백업은 며칠 치가 보관되나요?',
    '일 단위 30일, 월 단위 12개월을 보관합니다.',
  ],
  [
    'QUESTION',
    '외부에서 ERP 접속이 가능한가요?',
    '출장 중에도 ERP를 쓸 수 있는지 궁금합니다.',
    'VPN 접속 후 사용할 수 있습니다. 설정 안내서를 첨부했습니다.',
  ],
];
const PRIORITIES = ['LOW', 'NORMAL', 'NORMAL', 'NORMAL', 'HIGH', 'HIGH', 'URGENT'];
// 고정 순서의 의사 난수: 다시 만들어도 같은 모양의 데이터가 나와 시연 흐름을 미리 익혀 둘 수 있다.
let seed = 20261115;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = (a) => a[Math.floor(rand() * a.length)];
const HOUR = 3600 * 1000;

(async () => {
  console.log('1/4 시연 DB 준비');
  await resetDb();
  const request = require('supertest');
  const argon2 = require('argon2');
  const { createApp } = require('./dist/app');
  const { Db } = require('./dist/db');
  const { settings } = require('./dist/config');
  const app = await createApp();
  await app.init();
  const db = app.get(Db);
  db.useScriptWorkspace(await db.platformWorkspaceId());

  console.log('2/4 업체·고객사·계정 만들기');
  const ws = String(
    (await db.query("SELECT app.create_workspace('hanbit','한빛IT서비스') AS id")).rows[0].id,
  );
  const hash = await argon2.hash(password);
  // scope[아이디] = 그 고객 사용자의 법인·부서 ID. 요청 등록 때 쓴다.
  const scope = {};
  await db.tx(async (c) => {
    const resp = async (code) =>
      (await c.query('SELECT id FROM app.responsibilities WHERE code=$1', [code])).rows[0].id;
    const addUser = (loginId, name, respCode, customerId) =>
      c
        .query(
          `INSERT INTO app.users(login_id,password_hash,display_name,resp_id,must_change_password,customer_id,email)
           VALUES($1,$2,$3,$4,false,$5,$6) RETURNING id`,
          [loginId, hash, name, respCode, customerId, loginId + '@example.com'],
        )
        .then((r) => r.rows[0].id);
    for (const [id, name, role] of STAFF) await addUser(id, name, await resp(role), null);
    const customerResp = await resp('CUSTOMER_USER');
    for (const cu of CUSTOMERS) {
      const customer = (
        await c.query('INSERT INTO app.customers(code,name) VALUES($1,$2) RETURNING id', [
          cu.code,
          cu.name,
        ])
      ).rows[0].id;
      const depts = {};
      for (const corp of cu.corps) {
        const corpId = (
          await c.query(
            'INSERT INTO app.corporations(customer_id,code,name) VALUES($1,$2,$3) RETURNING id',
            [customer, corp.code, corp.name],
          )
        ).rows[0].id;
        for (const [code, name] of corp.depts)
          depts[corp.code + '/' + code] = {
            corpId,
            deptId: (
              await c.query(
                'INSERT INTO app.departments(customer_id,corporation_id,code,name) VALUES($1,$2,$3,$4) RETURNING id',
                [customer, corpId, code, name],
              )
            ).rows[0].id,
          };
      }
      // CUSTOMER 로그인 조건: 법인 매핑 1개 이상 + 그 법인의 실제 부서 매핑(AGENTS.md).
      for (const [loginId, name, corp, dept] of cu.users) {
        const uid = await addUser(loginId, name, customerResp, customer);
        const d = depts[corp + '/' + dept];
        await c.query(
          'INSERT INTO app.user_corporations(customer_id,user_id,corporation_id) VALUES($1,$2,$3)',
          [customer, uid, d.corpId],
        );
        await c.query(
          'INSERT INTO app.user_scopes(customer_id,user_id,corporation_id,department_id) VALUES($1,$2,$3,$4)',
          [customer, uid, d.corpId, d.deptId],
        );
        scope[loginId] = d;
      }
    }
  }, ws);
  // 서비스 운영자: 화면·메뉴·RESP 등록(메뉴·버튼 권한 편집)은 운영 워크스페이스에서만 열리므로(security.ts)
  // 그 워크스페이스에 관리 메뉴(seed.ts setupAdminMenu)와 시스템 관리자 RESP 계정을 하나 만든다.
  const { setupAdminMenu } = require('./dist/seed');
  await db.tx(async (c) => {
    const resp = await setupAdminMenu(c);
    await c.query(
      `INSERT INTO app.users(login_id,password_hash,display_name,resp_id,must_change_password,email)
       VALUES('demo_ops',$1,'서비스 운영자',$2,false,'demo_ops@example.com')`,
      [hash, resp],
    );
  });

  // 실제 화면과 같은 경로(로그인 → 메뉴 권한 헤더)로 API를 부른다. 시험(test/requests.test.cjs)과 같은 방식.
  const post = (who, url, data) =>
    who.agent
      .post('/api/' + url)
      .set('Origin', settings.origin)
      .set('X-CSRF-Token', who.csrf)
      .set('X-Menu-ID', who.menu)
      .send(data);
  const get = (who, url) => who.agent.get('/api/' + url).set('X-Menu-ID', who.menu);
  async function login(loginId, screen) {
    const agent = request.agent(app.getHttpServer());
    const who = { agent, csrf: (await agent.get('/api/auth/csrf')).body.csrfToken, menu: '0' };
    const r = await post(who, 'auth/login', { loginId, password });
    if (r.status !== 201) throw Error(loginId + ' 로그인 실패: ' + r.status);
    who.csrf = r.body.csrfToken;
    const nav = (await agent.get('/api/navigation')).body;
    who.menu = nav.screens.find((s) => s.code === screen)?.menu_id;
    return who;
  }
  const ok = async (p, what) => {
    const r = await p;
    if (r.status >= 300) throw Error(what + ' 실패: ' + r.status + ' ' + JSON.stringify(r.body));
    return r.body;
  };
  const engineers = [];
  for (const id of ['demo_kim', 'demo_lee', 'demo_park'])
    engineers.push(await login(id, 'SR_DESK'));
  const customers = {};
  for (const cu of CUSTOMERS)
    for (const [id] of cu.users) customers[id] = await login(id, 'SR_PORTAL');
  // 고객 사용자별 요청 비중: 대표 시연 계정(sml_lee·grn_jung)의 목록이 넉넉하게 차도록 더 자주 고른다.
  const requesters = [
    'sml_lee',
    'sml_lee',
    'sml_choi',
    'grn_jung',
    'grn_jung',
    'grn_oh',
    'dhp_han',
    'mre_yoon',
  ];

  console.log('3/4 요청 만들기');
  // 날짜 이동 계획: plans에 요청별 [이벤트 ID 경계, 그 동작의 시각]을 모아 두었다가 4단계에서 한 번에 바꾼다.
  const plans = [];
  const now = Date.now();
  const lastEvent = async (id) =>
    Number(
      (
        await db.query(
          'SELECT coalesce(max(id),0) AS m FROM app.request_events WHERE request_id=$1',
          [id],
          ws,
        )
      ).rows[0].m,
    );
  const TOTAL = 60;
  for (let i = 0; i < TOTAL; i++) {
    // 앞쪽(오래된) 요청은 대부분 완료, 최근 요청일수록 접수·처리 중·확인 대기가 섞이게 한다.
    const age = (TOTAL - i) / TOTAL; // 1(약 90일 전) → 0(오늘)
    const days = Math.pow(age, 1.5) * 88 + rand() * 0.5; // 최근일수록 촘촘하게
    let created = now - days * 24 * HOUR;
    const d = new Date(created);
    d.setHours(9 + Math.floor(rand() * 8), Math.floor(rand() * 60)); // 근무 시간(9~17시) 등록
    created = Math.min(d.getTime(), now - HOUR);
    // 가장 최근 3건은 항상 '접수'로 남겨 담당자 화면에 배정할 요청이 보이게 한다.
    const final =
      i >= TOTAL - 3
        ? 'OPEN'
        : days > 12
          ? rand() < 0.08
            ? 'CANCELLED'
            : 'CLOSED'
          : days > 5
            ? pick(['CLOSED', 'CLOSED', 'RESOLVED', 'IN_PROGRESS'])
            : pick(['OPEN', 'OPEN', 'IN_PROGRESS', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']);
    const [category, title, body, answer] = pick(TEMPLATES);
    const who = pick(requesters);
    const eng = pick(engineers);
    const sc = scope[who];
    const r = await ok(
      post(customers[who], 'requests/portal', {
        title,
        body,
        category,
        priority: pick(PRIORITIES),
        corporationId: String(sc.corpId),
        departmentId: String(sc.deptId),
      }),
      '요청 등록',
    );
    const steps = [{ upto: await lastEvent(r.id), at: created }];
    let t = created;
    const version = async () => (await ok(get(eng, 'requests/desk/' + r.id), '조회')).item.version;
    // 동작 하나를 실행하고 그 동작이 남긴 이벤트에 붙일 시각을 기록한다. gap: 앞 동작으로부터 걸린 시간.
    const act = async (gapHours, call) => {
      t = Math.min(t + gapHours * HOUR, now - 5 * 60 * 1000);
      await call();
      steps.push({ upto: await lastEvent(r.id), at: t });
    };
    if (final === 'CANCELLED') {
      await act(1 + rand() * 3, async () =>
        ok(
          post(eng, 'requests/desk/' + r.id, {
            version: await version(),
            action: 'CANCEL',
            comment: '고객 요청으로 취소합니다. 다른 요청과 중복입니다.',
          }),
          '취소',
        ),
      );
    } else if (final !== 'OPEN') {
      await act(0.3 + rand() * 3, async () =>
        ok(
          post(eng, 'requests/desk/' + r.id, {
            version: await version(),
            action: 'START',
            comment: '확인했습니다. 바로 살펴보겠습니다.',
          }),
          '처리 시작',
        ),
      );
      if (rand() < 0.4)
        await act(0.5 + rand() * 4, async () =>
          ok(
            post(eng, 'requests/desk/' + r.id, {
              version: await version(),
              comment: '원인 파악 중: 지난달 패치 이후 설정이 바뀐 것으로 보임',
              internal: true,
            }),
            '내부 메모',
          ),
        );
      if (rand() < 0.3)
        await act(1 + rand() * 6, () =>
          ok(
            post(customers[who], 'requests/portal/' + r.id + '/comment', {
              body: '혹시 오늘 중으로 가능할까요?',
            }),
            '고객 댓글',
          ),
        );
      if (final !== 'IN_PROGRESS') {
        await act(1 + rand() * 30, async () =>
          ok(
            post(eng, 'requests/desk/' + r.id, {
              version: await version(),
              action: 'RESOLVE',
              comment: answer,
            }),
            '처리 완료',
          ),
        );
        if (final === 'CLOSED')
          await act(2 + rand() * 40, async () =>
            ok(
              post(customers[who], 'requests/portal/' + r.id + '/confirm', {
                version: (await ok(get(customers[who], 'requests/portal/' + r.id), '조회')).item
                  .version,
              }),
              '고객 확인',
            ),
          );
      }
    }
    plans.push({ id: r.id, created, steps, final });
  }
  // 첨부 예시: 최근 요청 5건에 작은 화면 캡처 그림(16x16 PNG)을 요청자 계정으로 붙인다.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJklEQVR42mNkYPhfz0AEYBxVSF+FjP///ycqjI0aOKqQvgoZRwMSACnvFhHw9o6YAAAAAElFTkSuQmCC',
    'base64',
  );
  for (const p of plans
    .filter((x) => ['OPEN', 'IN_PROGRESS', 'RESOLVED'].includes(x.final))
    .slice(0, 5)) {
    const owner = (
      await db.query(
        'SELECT u.login_id FROM app.service_requests r JOIN app.users u ON u.id=r.requester_id WHERE r.id=$1',
        [p.id],
        ws,
      )
    ).rows[0].login_id;
    const who = customers[owner];
    await ok(
      who.agent
        .post('/api/requests/portal/' + p.id + '/attachments')
        .set('Origin', settings.origin)
        .set('X-CSRF-Token', who.csrf)
        .set('X-Menu-ID', who.menu)
        .attach('file', png, { filename: '오류 화면 캡처.png', contentType: 'image/png' }),
      '첨부',
    );
  }
  await app.close();

  console.log('4/4 날짜를 과거로 옮기기');
  // 요청 이벤트 표는 앱 계정에 수정 권한이 없어서(기록 보존) 관리 계정으로 바꾼다. 시연 DB에서만 하는 작업이다.
  const { Client } = require('pg');
  const c = new Client(pgConfig(DB));
  await c.connect();
  await c.query('BEGIN');
  for (const p of plans) {
    // 이벤트 ID가 경계(upto) 이하인 것 중 아직 시각을 받지 않은 것에 그 동작의 시각을 준다(경계는 오름차순).
    let from = 0;
    for (const s of [...p.steps].sort((a, b) => a.upto - b.upto)) {
      await c.query(
        'UPDATE app.request_events SET created_at=$3 WHERE request_id=$1 AND id>$4 AND id<=$2',
        [p.id, s.upto, new Date(s.at), from],
      );
      from = s.upto;
    }
    const last = Math.max(...p.steps.map((s) => s.at));
    // 기한(due_at·response_due_at)은 등록 시각과 같은 만큼 옮겨 SLA 계산 결과(정상·지연)가 실제처럼 나오게 한다.
    // 응답·완료·종료 시각은 해당 동작의 이벤트 시각으로 맞춘다.
    await c.query(
      `UPDATE app.service_requests r SET
         due_at = r.due_at + ($2::timestamptz - r.created_at),
         response_due_at = r.response_due_at + ($2::timestamptz - r.created_at),
         first_response_at = CASE WHEN r.first_response_at IS NULL THEN NULL ELSE
           (SELECT min(e.created_at) FROM app.request_events e JOIN app.users u ON u.id=e.actor_id
             WHERE e.request_id=r.id AND e.kind<>'CREATED' AND u.customer_id IS NULL) END,
         resolved_at = CASE WHEN r.resolved_at IS NULL THEN NULL ELSE
           (SELECT max(e.created_at) FROM app.request_events e WHERE e.request_id=r.id AND e.kind='STATUS' AND e.to_value='RESOLVED') END,
         closed_at = CASE WHEN r.closed_at IS NULL THEN NULL ELSE $3::timestamptz END,
         created_at = $2::timestamptz, updated_at = $3::timestamptz
       WHERE r.id=$1`,
      [p.id, new Date(p.created), new Date(last)],
    );
  }
  await c.query(
    "UPDATE app.request_attachments a SET created_at=r.created_at + interval '5 minutes' FROM app.service_requests r WHERE r.id=a.request_id",
  );
  // 첨부를 올리면 이력에 ATTACH 이벤트가 생기는데, 위 단계별 시각 맞추기(경계 ID 이하만)보다 나중에 생겨 오늘 날짜로 남았다.
  // 이력 화면에서 첨부 줄만 '오늘'로 보이지 않도록 해당 첨부 파일의 시각(등록 5분 뒤)과 같게 맞춘다.
  await c.query(
    `UPDATE app.request_events e SET created_at=a.created_at
       FROM app.request_attachments a
      WHERE e.request_id=a.request_id AND e.kind='ATTACH' AND e.body=a.file_name`,
  );
  // 알림: 요청의 마지막 변경 시각으로 맞추고, 사흘보다 오래된 것은 읽음으로 둔다(종 아이콘에 최근 것만 남게).
  await c.query(
    `UPDATE app.notifications n SET created_at=r.updated_at,
       read_at = CASE WHEN r.updated_at < now() - interval '3 days' THEN r.updated_at END
     FROM app.service_requests r WHERE r.id=n.request_id`,
  );
  await nestMenus(c);
  await c.query('COMMIT');
  await c.end();

  // 서버가 로그인 화면에 보여 줄 시연 계정 목록. 한 줄 JSON이라 .env 형식으로 읽을 수 있다.
  const accounts = SHOWN.map(([role, loginId, note]) => ({ role, loginId, password, note }));
  fs.writeFileSync(
    path.join(root, '.env.demo'),
    '# scripts/demo.ps1 -Sample이 읽는 시연 계정 목록(backend/demo-seed.cjs가 만든다). 저장소에 올리지 않는다.\n' +
      'DEMO_ACCOUNTS=' +
      JSON.stringify(accounts) +
      '\n',
  );
  const count = plans.reduce((m, p) => ((m[p.final] = (m[p.final] || 0) + 1), m), {});
  console.log('완료: 요청', plans.length, '건', JSON.stringify(count), '· 시연 계정은 .env.demo');
})().then(
  // 앱의 배경 작업(메일 발송·자동 완료 타이머)이 남아 있어도 끝나도록 명시적으로 종료한다.
  // 실패 때 그대로 두면 창이 멈춘 것처럼 보이고 demo.ps1이 다음 단계로 넘어가지 못한다.
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
