/**
 * 화면 사용 설명서(frontend/public/manual) 촬영 스크립트.
 * 빈 DB(doneline_manual)를 새로 만들고 가상의 업체 '한빛IT서비스'와 고객사 '서울메디랩'으로
 * 업체 가입 → 기본 등록 → 직원 등록 → 고객 가입·승인 → 요청 등록 → 처리 → 완료 확인까지 실제 화면으로 진행하며
 * 화면 사진(png)과 짧은 영상(webm)을 frontend/public/manual/media에 저장한다.
 * 화면이 바뀌면 이 스크립트를 다시 실행해 설명서 그림을 최신으로 맞춘다.
 *
 * 사용: npm run build && node backend/manual-capture.cjs
 * 준비: 루트 .env.db-admin(DB 관리 계정)·.env(앱 계정)와 Edge가 필요하다. 3300 포트를 쓴다. 실행할 때마다 doneline_manual을 지우고 다시 만든다.
 * 부수 효과: doneline_manual DB 재생성, media 폴더 파일 덮어쓰기. 다른 DB와 슬랙 알림에는 영향이 없다.
 */
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const DB = 'doneline_manual';
const PORT = 3300;
const ORIGIN = 'http://127.0.0.1:' + PORT;
const out = path.join(root, 'frontend/public/manual/media');
const PW = 'Manual demo password 2026!';

// 앱이 읽기 전에 촬영용 DB·주소를 지정하고, 실제 슬랙 알림이 나가지 않도록 비운다(.env보다 우선).
process.env.PGDATABASE = DB;
process.env.APP_ORIGIN = ORIGIN;
process.env.SLACK_WEBHOOK_URL = '';

/**
 * DB 관리 계정으로 촬영용 DB를 지우고 새로 만든 뒤 마이그레이션을 적용한다.
 * seed(운영 관리자 생성)는 실행하지 않는다: 촬영은 업체 셀프 가입부터 시작하므로 운영 관리자가 필요 없고,
 * seed는 기존 .env.bootstrap이 있으면 덮어쓰지 않으려고 실패하기 때문이다.
 */
async function resetDb() {
  // 관리 계정 값은 이 함수 안에서만 쓰고 process.env에 넣지 않는다(앱은 .env의 앱 계정으로 접속해야 한다).
  const admin = require('dotenv').parse(fs.readFileSync(path.join(root, '.env.db-admin')));
  const { Client } = require('pg');
  const c = new Client({ ...pgConfig(admin), database: 'postgres' });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${DB}`);
  await c.end();
  const env = { ...process.env, ...admin, PGDATABASE: DB };
  execFileSync('node', ['backend/migrate.cjs'], { cwd: root, env, stdio: 'ignore' });
}
const pgConfig = (e) => ({
  host: e.PGHOST,
  port: Number(e.PGPORT || 5432),
  user: e.PGUSER,
  password: e.PGPASSWORD,
});

// 촬영 화면에 덧씌우는 표시: 가짜 마우스 포인터(영상용)와 번호 강조 상자(사진용).
// 헤드리스 브라우저는 마우스 포인터를 그리지 않으므로 mousemove를 따라다니는 점을 직접 그린다.
const overlayScript = () => {
  window.addEventListener('DOMContentLoaded', () => {
    const dot = document.createElement('div');
    dot.id = 'mm-cursor';
    dot.style.cssText =
      'position:fixed;left:-40px;top:-40px;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;' +
      'background:rgb(225 29 72 / 35%);border:2px solid #e11d48;z-index:2147483647;pointer-events:none;transition:transform .12s';
    document.body.appendChild(dot);
    addEventListener('mousemove', (e) => {
      dot.style.left = e.clientX + 'px';
      dot.style.top = e.clientY + 'px';
    });
    addEventListener('mousedown', () => (dot.style.transform = 'scale(.6)'));
    addEventListener('mouseup', () => (dot.style.transform = ''));
  });
};

(async () => {
  console.log('1/3 촬영용 DB 준비');
  await resetDb();
  fs.mkdirSync(out, { recursive: true });
  const { chromium } = require('playwright');
  const { expect } = require('playwright/test');
  const { createApp } = require('./dist/app');
  const { Db } = require('./dist/db');
  const app = await createApp();
  const db = app.get(Db);
  db.useScriptWorkspace(await db.platformWorkspaceId());
  await app.listen(PORT, '127.0.0.1');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const desktop = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: 'ko-KR' };
  const mobile = {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'ko-KR',
  };
  const videos = new Map();
  /** 녹화 중인 창을 닫아 영상을 마무리하고 이름을 붙인다. 영상마다 한 가지 작업만 담기도록 작업이 끝나면 바로 부른다. */
  async function finish(page) {
    const v = videos.get(page);
    await page.waitForTimeout(800);
    const file = await page.video().path();
    await v.ctx.close();
    fs.renameSync(file, path.join(out, v.name + '.webm'));
    videos.delete(page);
  }
  /** 새 브라우저 창(쿠키가 분리된 사용자 한 명)을 연다. video 이름을 주면 그 창의 동작을 영상으로 녹화한다. */
  async function newUser(device, video, url = ORIGIN) {
    const ctx = await browser.newContext({
      ...device,
      ...(video ? { recordVideo: { dir: out, size: device.viewport } } : {}),
    });
    await ctx.addInitScript(overlayScript);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('page error:', e.message));
    page.on('dialog', (d) => d.accept());
    if (video) videos.set(page, { ctx, name: video });
    // 비밀번호 링크(#account=…)는 첫 로딩 때만 읽으므로 처음부터 그 주소로 연다.
    await page.goto(url);
    return page;
  }

  // --- 사진·영상 도우미 ---
  // 사진: 강조할 요소들에 빨간 테두리와 번호표를 붙이고 찍은 뒤 지운다.
  async function shot(page, name, marks = []) {
    // 첫 강조 대상이 화면 밖이면 보이도록 스크롤하고, 영상용 가짜 포인터는 사진에서 숨긴다.
    if (marks[0]) await marks[0].scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await page.evaluate(() =>
      document.getElementById('mm-cursor')?.style.setProperty('visibility', 'hidden'),
    );
    await page.waitForTimeout(400);
    let n = 0;
    for (const m of marks) {
      n++;
      // 강조 대상을 못 찾으면 촬영을 멈추지 않고 알린 뒤 번호만 건너뛴다.
      const box = await m.boundingBox({ timeout: 3000 }).catch(() => null);
      if (!box) {
        console.warn('강조 대상 없음:', name, n);
        continue;
      }
      await page.evaluate(
        ({ box, n }) => {
          const r = document.createElement('div');
          r.className = 'mm-mark';
          r.style.cssText = `position:fixed;left:${box.x - 4}px;top:${box.y - 4}px;width:${box.width + 8}px;height:${box.height + 8}px;border:3px solid #e11d48;border-radius:8px;z-index:2147483646;pointer-events:none`;
          const b = document.createElement('div');
          b.className = 'mm-mark';
          b.textContent = n;
          b.style.cssText = `position:fixed;left:${Math.max(2, box.x - 16)}px;top:${Math.max(2, box.y - 16)}px;width:24px;height:24px;border-radius:50%;background:#e11d48;color:#fff;font:700 14px/24px sans-serif;text-align:center;z-index:2147483647;pointer-events:none`;
          document.body.append(r, b);
        },
        { box, n },
      );
    }
    await page.screenshot({ path: path.join(out, name + '.png') });
    await page.evaluate(() => {
      document.querySelectorAll('.mm-mark').forEach((e) => e.remove());
      document.getElementById('mm-cursor')?.style.removeProperty('visibility');
    });
  }
  // 영상에서 사람이 따라가기 쉽게 포인터를 천천히 옮긴 뒤 누른다.
  async function click(page, loc) {
    await loc.scrollIntoViewIfNeeded();
    const b = await loc.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
    await page.waitForTimeout(250);
    await loc.click();
    await page.waitForTimeout(350);
  }
  async function type(page, loc, text) {
    await click(page, loc);
    await loc.pressSequentially(text, { delay: 35 });
  }
  async function login(page, id) {
    await page.getByLabel('아이디', { exact: true }).fill(id);
    await page.getByLabel('비밀번호', { exact: true }).fill(PW);
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await expect(page.getByRole('button', { name: '로그아웃' })).toBeVisible();
  }
  // 선택 상자는 선택지 글자까지 이름에 섞이고, 업체 가입 화면의 입력칸은 이름 뒤에 안내문이 붙어 있어 정확한 이름 대신 '이름으로 시작'으로 찾는다.
  // ' 확인'이 이어지는 칸(비밀번호 확인)은 '비밀번호'와 구분한다.
  const field = (page, label) =>
    page
      .locator('label')
      .filter({ hasText: new RegExp('^' + label + '(?! 확인)') })
      .locator('input, select, textarea')
      .first();
  const menu = (page, name) => page.locator('aside').getByRole('button', { name, exact: true });
  const active = (page) => page.locator('.content>div:not([hidden])');
  const toolbarBtn = (page, name) =>
    page.locator('.toolbar').getByRole('button', { name, exact: true });
  // 고객사·법인·부서 그리드에 한 행을 추가하고 저장한다(accounts-browser 테스트와 같은 조작).
  async function addCatalogRow(page, kind, title, code, name) {
    const panel = active(page);
    await click(page, panel.getByRole('button', { name: '행추가', exact: true }));
    const grid = panel.getByLabel(title + ' 편집', { exact: true });
    const row = grid.locator('.ag-row[row-id*="-"]').last();
    const key = await row.getAttribute('row-id');
    for (const [field, value] of [
      ['code', code],
      ['name', name],
    ]) {
      const cell = grid.locator('.ag-row[row-id="' + key + '"] [col-id="' + field + '"]');
      await cell.dblclick();
      await cell.locator('input').pressSequentially(value, { delay: 25 });
      await cell.locator('input').press('Enter');
    }
    return async () => {
      await Promise.all([
        page.waitForResponse((r) => r.url().includes('/catalogs/' + kind + '/save')),
        click(page, toolbarBtn(page, '저장')),
      ]);
    };
  }

  console.log('2/3 화면 촬영');
  // ===== 1. 업체 관리자: 가입 =====
  const signupPage = await newUser(desktop, 'v1-workspace-signup');
  {
    const ceo = signupPage;
    await shot(ceo, '01-login', [ceo.getByRole('button', { name: '무료로 시작하기' })]);
    await click(ceo, ceo.getByRole('button', { name: '무료로 시작하기' }));
    for (const [label, value] of [
      ['업체명', '한빛IT서비스'],
      ['업체 코드', 'hanbit-it'],
      ['관리자 이름', '김대표'],
      ['아이디', 'hanbit_ceo'],
      ['이메일', 'ceo@hanbit.example'],
      ['휴대전화', '010-1234-5678'],
    ])
      await type(ceo, field(ceo, label), value);
    await field(ceo, '비밀번호').fill(PW);
    await field(ceo, '비밀번호 확인').fill(PW);
    await shot(ceo, '02-workspace-signup', [ceo.getByRole('button', { name: '가입하기' })]);
    await click(ceo, ceo.getByRole('button', { name: '가입하기' }));
    await expect(ceo.getByRole('button', { name: '로그아웃' })).toBeVisible();
    await ceo.waitForTimeout(1200);
    await shot(ceo, '03-start-guide', [ceo.locator('.start-guide')]);
    await finish(ceo);
  }

  // ===== 2. 기본 등록: 고객사 → 법인 → 부서(영상) =====
  let ceo = await newUser(desktop, 'v5-setup');
  await login(ceo, 'hanbit_ceo');
  await click(ceo, menu(ceo, '고객사등록'));
  let save = await addCatalogRow(ceo, 'customers', '고객사', 'SMLAB', '서울메디랩');
  await shot(ceo, '04-customers', [
    active(ceo).getByRole('button', { name: '행추가', exact: true }),
    active(ceo).locator('.ag-row[row-id*="-"]').last(),
    toolbarBtn(ceo, '저장'),
  ]);
  await save();
  await click(ceo, menu(ceo, '법인등록'));
  await click(ceo, active(ceo).getByLabel('고객사 목록', { exact: true }).getByText('SMLAB'));
  save = await addCatalogRow(ceo, 'corporations', '법인', 'HQ', '서울메디랩 본사');
  await shot(ceo, '05-corporations', [
    active(ceo).getByLabel('고객사 목록', { exact: true }).getByText('SMLAB'),
    active(ceo).locator('.ag-row[row-id*="-"]').last(),
  ]);
  await save();
  await click(ceo, menu(ceo, '부서등록'));
  await click(ceo, active(ceo).getByLabel('고객사 목록', { exact: true }).getByText('SMLAB'));
  await click(
    ceo,
    active(ceo).getByLabel('법인 목록', { exact: true }).getByText('서울메디랩 본사'),
  );
  save = await addCatalogRow(ceo, 'departments', '부서', 'GA', '총무팀');
  await save();
  save = await addCatalogRow(ceo, 'departments', '부서', 'RND', '연구지원팀');
  await shot(ceo, '06-departments', [
    active(ceo).getByLabel('고객사 목록', { exact: true }).getByText('SMLAB'),
    active(ceo).getByLabel('법인 목록', { exact: true }).getByText('서울메디랩 본사'),
    active(ceo).getByLabel('부서 편집', { exact: true }),
  ]);
  await save();

  await finish(ceo);
  // ===== 3. 우리 직원 등록과 비밀번호 설정 링크 =====
  ceo = await newUser(desktop);
  await login(ceo, 'hanbit_ceo');
  await click(ceo, menu(ceo, '사용자등록'));
  let panel = ceo.locator('.account-screen:visible');
  await panel.getByLabel('고객사', { exact: true }).selectOption('system');
  await click(ceo, toolbarBtn(ceo, '조회'));
  await click(ceo, toolbarBtn(ceo, '초기화'));
  await type(ceo, panel.getByLabel('아이디', { exact: true }), 'hanbit_park');
  await type(ceo, panel.getByLabel('이름', { exact: true }), '박주임');
  await panel.getByLabel('이메일', { exact: true }).fill('park@hanbit.example');
  await panel.getByLabel('휴대전화번호', { exact: true }).fill('010-2222-3333');
  await panel.getByLabel('역할', { exact: true }).selectOption({ label: '업체 담당자' });
  await click(ceo, toolbarBtn(ceo, '저장'));
  const linkBox = panel.locator('.link-box');
  await expect(linkBox).toBeVisible();
  const parkLink = (await linkBox.locator('code').textContent()).trim();
  await shot(ceo, '07-staff-link', [panel.getByLabel('고객사', { exact: true }), linkBox]);
  // 박주임: 받은 링크로 비밀번호 설정(휴대폰)
  const park = await newUser(mobile, null, parkLink);
  await expect(park.getByRole('heading', { name: '비밀번호 설정' })).toBeVisible();
  await park.getByLabel('새 비밀번호', { exact: true }).fill(PW);
  await park.getByLabel('새 비밀번호 확인', { exact: true }).fill(PW);
  await shot(park, '08-password-setup', [park.locator('.signup-banner')]);
  await park.getByRole('button', { name: '완료', exact: true }).click();
  await expect(park.getByRole('button', { name: '로그아웃' })).toBeVisible();

  // ===== 4. 고객사 가입 링크 전달 =====
  await click(ceo, menu(ceo, '고객사등록'));
  await click(ceo, active(ceo).getByText('서울메디랩', { exact: true }).first());
  const signupBox = active(ceo).locator('.link-box').or(ceo.locator('.link-box:visible')).first();
  await expect(signupBox).toBeVisible();
  await shot(ceo, '09-signup-link', [signupBox.getByRole('button', { name: '가입 링크 복사' })]);
  // 관리자가 복사해 보내는 링크와 똑같이 화면에 표시된 주소를 그대로 쓴다.
  const signupUrl = (await signupBox.locator('code').textContent()).trim();

  // ===== 5. 고객 담당자 가입 신청(휴대폰) =====
  const lee = await newUser(mobile, null, signupUrl);
  await shot(lee, '10-customer-signup-entry', [
    lee.getByRole('button', { name: '회원가입', exact: true }),
  ]);
  await lee.getByRole('button', { name: '회원가입', exact: true }).click();
  for (const [label, value] of [
    ['아이디', 'smlab_lee'],
    ['이름', '이과장'],
    ['휴대전화번호', '010-4444-5555'],
    ['주소', '서울시 강남구'],
    ['이메일', 'lee@smlab.example'],
  ])
    await field(lee, label).fill(value);
  await field(lee, '비밀번호').fill(PW);
  await field(lee, '비밀번호 확인').fill(PW);
  await shot(lee, '11-customer-signup-form');
  await lee.getByRole('button', { name: '가입 신청', exact: true }).click();
  await expect(lee.getByRole('status').filter({ hasText: '가입 신청이 완료' })).toBeVisible();

  // ===== 6. 가입 승인(영상) =====
  const ceo2 = await newUser(desktop, 'v2-approve');
  await login(ceo2, 'hanbit_ceo');
  await ceo2.waitForTimeout(600);
  await shot(ceo2, '12-signup-notification', [ceo2.getByRole('button', { name: /^알림/ })]);
  await click(ceo2, menu(ceo2, '사용자등록'));
  panel = ceo2.locator('.account-screen:visible');
  await panel.getByLabel('고객사', { exact: true }).selectOption({ label: 'SMLAB · 서울메디랩' });
  await click(ceo2, toolbarBtn(ceo2, '조회'));
  await expect(panel.getByText('smlab_lee', { exact: true })).toBeVisible();
  await click(ceo2, panel.getByRole('checkbox', { name: '사용자 목록 행 선택 1', exact: true }));
  await click(ceo2, toolbarBtn(ceo2, '승인'));
  const quick = ceo2.getByRole('dialog', { name: '가입 승인' });
  await expect(quick).toBeVisible();
  await quick.locator('select').selectOption({ label: '고객사 사용자' });
  await click(ceo2, quick.getByLabel('서울메디랩 본사 / 총무팀', { exact: true }));
  await shot(ceo2, '13-approve-dialog', [
    quick.locator('select'),
    quick.getByLabel('서울메디랩 본사 / 총무팀', { exact: true }),
    quick.getByRole('button', { name: '승인', exact: true }),
  ]);
  await Promise.all([
    ceo2.waitForResponse((r) => r.url().endsWith('/accounts/mapping')),
    click(ceo2, quick.getByRole('button', { name: '승인', exact: true })),
  ]);
  await expect(
    panel.locator('.ag-row').filter({ hasText: 'smlab_lee' }).getByText('승인 완료'),
  ).toBeVisible();
  await finish(ceo2);

  // ===== 7. 고객: 요청 등록(휴대폰 영상) =====
  const lee2 = await newUser(mobile, 'v3-request-mobile');
  await login(lee2, 'smlab_lee');
  await click(lee2, lee2.getByRole('button', { name: '+ 새 요청' }));
  const form = lee2.locator('.sr-detail');
  await type(lee2, field(form, '제목'), '회의실 프로젝터 화면이 안 나옵니다');
  await field(form, '구분').selectOption({ label: '장애' });
  await field(form, '긴급도').selectOption({ label: '높음' });
  await field(form, '법인 / 부서').selectOption({ index: 1 });
  await type(
    lee2,
    field(form, '내용'),
    '3층 대회의실 노트북 연결 시 "신호 없음"이 표시됩니다. 오후 2시 회의 전 확인 부탁드립니다.',
  );
  await shot(lee2, '14-request-form', [form.getByRole('button', { name: '요청 등록' })]);
  await click(lee2, form.getByRole('button', { name: '요청 등록' }));
  await expect(lee2.locator('.sr-card').first()).toBeVisible();
  await lee2.waitForTimeout(800);
  await shot(lee2, '15-request-list', [lee2.locator('.sr-card').first()]);
  await finish(lee2);
  // 이후 장면은 녹화하지 않는 새 창으로 이어 간다.
  const lee3 = await newUser(mobile);
  await login(lee3, 'smlab_lee');
  // 목록을 풍성하게 보이도록 요청 두 건을 화면과 같은 API로 더 등록한다.
  await lee3.evaluate(async () => {
    const csrf = (await (await fetch('/api/auth/csrf')).json()).csrfToken;
    const nav = await (await fetch('/api/navigation')).json();
    const menuId = nav.screens.find((s) => s.code === 'SR_PORTAL').menu_id;
    const scope = (
      await (await fetch('/api/requests/portal', { headers: { 'X-Menu-ID': menuId } })).json()
    ).scopes[0];
    for (const [title, category, priority] of [
      ['신규 입사자 메일 계정 생성 요청', 'REQUEST', 'NORMAL'],
      ['그룹웨어 결재선 변경 방법 문의', 'QUESTION', 'LOW'],
    ])
      await fetch('/api/requests/portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'X-Menu-ID': menuId },
        body: JSON.stringify({
          title,
          category,
          priority,
          body: title + '입니다.',
          corporationId: String(scope.corporation_id),
          departmentId: String(scope.department_id),
        }),
      });
  });

  // ===== 8. 엔지니어: 알림 → 배정·답변·완료(영상) =====
  const park2 = await newUser(desktop, 'v4-desk-process');
  await login(park2, 'hanbit_park');
  await park2.waitForTimeout(600);
  await click(park2, park2.getByRole('button', { name: /^알림/ }));
  await park2.waitForTimeout(500);
  await shot(park2, '16-notifications', [park2.locator('.bell-panel')]);
  const firstNote = park2.locator('.bell-item').filter({ hasText: '프로젝터' }).first();
  if (await firstNote.count()) await click(park2, firstNote);
  else {
    await park2.keyboard.press('Escape');
    await click(park2, menu(park2, '요청 작업함'));
    await click(park2, active(park2).getByText('회의실 프로젝터 화면이 안 나옵니다').first());
  }
  const card = park2
    .locator('.account-card')
    .filter({ has: park2.getByRole('heading', { name: '회의실 프로젝터 화면이 안 나옵니다' }) });
  await expect(card).toBeVisible();
  await field(card, '상태').selectOption({ label: '처리 중' });
  await field(card, '담당자').selectOption({ label: '박주임' });
  await type(park2, field(card, '답변 / 메모'), '확인했습니다. 10분 내 방문하겠습니다.');
  await shot(park2, '17-desk-detail', [
    field(card, '상태'),
    field(card, '담당자'),
    field(card, '답변 / 메모'),
    toolbarBtn(park2, '저장'),
  ]);
  await click(park2, toolbarBtn(park2, '저장'));
  await park2.waitForTimeout(1000);
  await field(card, '상태').selectOption({ label: '처리 완료 (고객 확인 대기)' });
  await type(park2, field(card, '답변 / 메모'), 'HDMI 케이블 교체 후 정상 출력됩니다.');
  await click(park2, toolbarBtn(park2, '저장'));
  await park2.waitForTimeout(1200);
  await shot(park2, '18-desk-list', [active(park2).getByLabel('요청 목록', { exact: true })]);
  await finish(park2);

  // ===== 9. 고객: 완료 확인 =====
  await lee3.reload();
  await expect(lee3.locator('.sr-card').first()).toBeVisible();
  await click(lee3, lee3.locator('.sr-card').filter({ hasText: '프로젝터' }));
  await expect(lee3.getByRole('button', { name: '완료 확인' }).last()).toBeVisible();
  await lee3.locator('.sr-decide').scrollIntoViewIfNeeded();
  await shot(lee3, '19-confirm', [lee3.locator('.sr-decide')]);
  await click(lee3, lee3.locator('.sr-decide').getByRole('button', { name: '완료 확인' }));
  await lee3.waitForTimeout(800);

  // ===== 10. 운영 화면: SLA·리포트·개선 요청 =====
  const ceo3 = await newUser(desktop);
  await login(ceo3, 'hanbit_ceo');
  await click(ceo3, menu(ceo3, 'SLA 설정'));
  await ceo3.waitForTimeout(800);
  await shot(ceo3, '20-sla');
  await click(ceo3, menu(ceo3, '월간 리포트'));
  await click(ceo3, toolbarBtn(ceo3, '조회'));
  await ceo3.waitForTimeout(800);
  await shot(ceo3, '21-report', [toolbarBtn(ceo3, '엑셀 다운로드')]);
  await click(ceo3, ceo3.getByRole('button', { name: '개선 요청' }).first());
  await shot(ceo3, '22-feedback', [ceo3.getByRole('dialog', { name: '개선 요청' })]);
  await ceo3.keyboard.press('Escape');

  console.log('3/3 정리');
  await browser.close();
  await app.close();
  // 녹화하지 않은 창의 임시 영상 조각이 남지 않도록 정리한다.
  for (const f of fs.readdirSync(out))
    if (/^page@[0-9a-f]+\.webm$/.test(f)) fs.unlinkSync(path.join(out, f));
  console.log('완료:', out);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
