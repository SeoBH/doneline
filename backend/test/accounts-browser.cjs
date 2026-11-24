/** 고객사 코드 등록 → 공개 가입 → 관리자 승인 → 직접 등록을 실제 화면으로 검증한다. 테스트 DB와 3002 포트를 사용한다. */
process.env.PGDATABASE = 'doneline_test';
// 테스트 중 실제 슬랙 알림이 나가지 않도록 빈 값으로 고정한다(.env보다 우선).
process.env.SLACK_WEBHOOK_URL = '';
process.env.APP_ORIGIN = 'http://127.0.0.1:3002';
// 시험 브라우저 전용: 앱 공통 확인 창(ConfirmDialog, role=alertdialog)이 뜨면 0.05초 안에 [확인]을 누르고 문구를 기록한다.
// (예전 브라우저 기본 confirm을 page.on('dialog')로 수락하던 것과 같은 역할. 응답을 기다리는 중에도 동작한다.)
const autoConfirm = () => {
  window.__confirms = [];
  setInterval(() => {
    const box = document.querySelector('[role="alertdialog"]');
    if (!box) return;
    window.__confirms.push(box.querySelector('p')?.textContent || '');
    box.querySelector('.confirm-actions button:last-child')?.click();
  }, 50);
};
const { chromium } = require('playwright');
const { expect } = require('playwright/test');
const { createApp } = require('../dist/app');
const { Db } = require('../dist/db');
const { openMail } = require('../dist/mail');
const argon2 = require('argon2');
const { mkdir } = require('node:fs/promises');
const path = require('node:path');
(async () => {
  let app, browser, page, signup;
  // 코드는 테스트 DB에 고객사가 쌓여도 코드순 목록(ORDER BY code) 맨 앞에 와야 한다. 표는 화면에 보이는 줄만 그리므로
  // 뒤로 밀리면 테스트가 행을 찾지 못한다. 예전 '0browser_임의값' 방식은 그런 행이 쌓이며 새 행이 밀려났다(2026-11-24).
  // '00b' + (9조 − 현재 ms): 예전 코드보다 앞서고, 실행할 때마다 숫자가 작아져 가장 최근 고객사가 항상 맨 위에 온다.
  const code = '00b' + String(9e12 - Date.now()),
    password = 'Browser account password 123!';
  try {
    app = await createApp();
    const db = app.get(Db);
    // 테스트 준비 SQL은 HTTP 요청 밖에서 실행되므로 운영 워크스페이스를 기본 범위로 지정한다.
    db.useScriptWorkspace(await db.platformWorkspaceId());
    await db.query('DELETE FROM app.login_limits');
    await db.query(
      "INSERT INTO app.users(login_id,password_hash,display_name,resp_id,must_change_password) SELECT $1,$2,$1,id,false FROM app.responsibilities WHERE code='ADMIN'",
      [code, await argon2.hash(password)],
    );
    await app.listen(3002, '127.0.0.1');
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    page = await browser.newPage({ viewport: { width: 1700, height: 1050 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(autoConfirm);
    await page.goto('http://127.0.0.1:3002');
    await page.getByLabel('아이디', { exact: true }).fill(code);
    await page.getByLabel('비밀번호', { exact: true }).fill(password);
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    const toolbar = page.locator('.toolbar'),
      active = () => page.locator('.content>div:not([hidden])');
    const open = async (name) =>
      page.locator('aside').getByRole('button', { name, exact: true }).click();
    async function catalog(kind, title, entry, name) {
      const panel = active();
      await panel.getByRole('button', { name: '행추가', exact: true }).click();
      await expect(
        panel.getByLabel(title + ' 편집', { exact: true }).locator('.ag-row[row-id*="-"]'),
      ).toHaveCount(1);
      const grid = panel.getByLabel(title + ' 편집', { exact: true }),
        row = grid.locator('.ag-row[row-id*="-"]'),
        key = await row.getAttribute('row-id');
      for (const [field, value] of [
        ['code', entry],
        ['name', name],
      ]) {
        const cell = grid.locator('.ag-row[row-id="' + key + '"] [col-id="' + field + '"]');
        await cell.dblclick();
        await cell.locator('input').fill(value);
        await cell.locator('input').press('Enter');
      }
      const [response] = await Promise.all([
        page.waitForResponse(
          (r) => r.url().includes('/catalogs/' + kind + '/save') && r.request().method() === 'POST',
        ),
        toolbar.getByRole('button', { name: '저장', exact: true }).click(),
      ]);
      expect(response.status()).toBe(201);
      await expect(
        grid.getByRole('checkbox', { name: new RegExp('행 선택') }).last(),
      ).not.toBeChecked();
      // 저장 직후 같은 값이 두 줄로 보이면 안 된다(QA 5차 DV5-003): 임시 키(UUID) 행은 사라지고 DB 행 1개만 남는다.
      await expect(grid.locator('.ag-row[row-id="' + key + '"]')).toHaveCount(0);
      // 고객사 목록은 테스트 DB에 쌓인 다른 고객사 때문에 새 행이 화면 밖일 수 있어, 상위가 새로 만든 고객사인 법인·부서에서만 센다.
      if (kind !== 'customers')
        await expect(
          grid.locator('[role="gridcell"][col-id="code"]').filter({ hasText: entry }),
        ).toHaveCount(1);
    }
    await open('고객사등록');
    await catalog('customers', '고객사', code, '브라우저 고객사');
    await open('법인등록');
    await active()
      .getByLabel('고객사 목록', { exact: true })
      .getByText(code, { exact: true })
      .click();
    await catalog('corporations', '법인', 'A001', '법인 하나');
    await open('부서등록');
    await active()
      .getByLabel('고객사 목록', { exact: true })
      .getByText(code, { exact: true })
      .click();
    await active()
      .getByLabel('법인 목록', { exact: true })
      .getByText('법인 하나', { exact: true })
      .click();
    await catalog('departments', '부서', 'D001', '개발');
    signup = await browser.newPage();
    signup.on('pageerror', (e) => errors.push(e.message));
    const token = (await db.query('SELECT signup_token FROM app.customers WHERE code=$1', [code]))
      .rows[0].signup_token;
    await signup.goto('http://127.0.0.1:3002/?signup=' + token);
    await signup.getByRole('button', { name: '회원가입', exact: true }).click();
    await expect(signup.getByText(code + ' · 브라우저 고객사', { exact: true })).toHaveCount(0);
    await signup.getByLabel('아이디', { exact: true }).fill(code + '_applicant');
    await signup.getByLabel('이름', { exact: true }).fill('가입 신청자');
    await signup.getByLabel('비밀번호', { exact: true }).fill(password);
    await signup.getByLabel('비밀번호 확인', { exact: true }).fill(password);
    await signup.getByLabel('휴대전화번호', { exact: true }).fill('010-1111-2222');
    await signup.getByLabel('주소 (선택)', { exact: true }).fill('서울');
    await signup.getByLabel('이메일', { exact: true }).fill(code + '@example.com');
    await expect(signup.getByLabel('역할', { exact: true })).toHaveCount(0);
    await signup.getByRole('button', { name: '가입 신청', exact: true }).click();
    await expect(signup.getByRole('status').filter({ hasText: '가입 신청이 완료' })).toBeVisible();
    await page.locator('aside').getByRole('button', { name: '사용자등록', exact: true }).click();
    const panel = page.locator('.account-screen:visible');
    // 고르기 칸 글에는 사용자 수가 붙는다(예: '… · 브라우저 고객사 (1명 · 승인 대기 1)'). 코드로 찾아 고른다.
    const customerSelect = panel.getByLabel('고객사', { exact: true });
    // 방금 가입 신청한 1명이 이 고객사의 '승인 대기'로 표시된다(QA DLV2-005).
    await expect(
      customerSelect.locator('option', {
        hasText: code + ' · 브라우저 고객사 (1명 · 승인 대기 1)',
      }),
    ).toHaveCount(1);
    await customerSelect.selectOption(
      await customerSelect
        .locator('option', { hasText: code + ' · 브라우저 고객사' })
        .getAttribute('value'),
    );
    // 고객사를 고르면 [조회] 없이 바로 읽는다(QA DLV2-004). 읽기가 끝날 때까지(툴바 잠김 해제) 기다린다.
    await page.waitForFunction(() => !document.querySelector('.toolbar button:disabled'));
    await expect(panel.getByText(code + '_applicant', { exact: true })).toBeVisible();
    await expect(panel.getByLabel('승인 RESP', { exact: true })).toHaveCount(0);
    await panel.getByText(code + '_applicant', { exact: true }).click();
    await expect(panel.getByLabel('아이디', { exact: true })).toHaveValue(code + '_applicant');
    // 가입 신청 1건 승인: [승인]을 누르면 역할과 소속 부서를 한 번에 고르는 창이 열린다.
    // 고객사를 바꾸면 이전 고객사의 행이 잠깐 사라지는 효과(투명해지는 중)로 남아 있으므로 신청자 행에서 체크한다.
    // 체크 칸은 왼쪽 고정 영역의 별도 줄에 있어, 글이 있는 줄의 row-id로 같은 행의 체크 칸을 찾는다.
    const applicantId = await panel
      .locator('.ag-row:not(.ag-opacity-zero)', { hasText: code + '_applicant' })
      .first()
      .getAttribute('row-id');
    await panel
      .locator(`.ag-row[row-id="${applicantId}"]:not(.ag-opacity-zero)`)
      .getByRole('checkbox')
      .click();
    await toolbar.getByRole('button', { name: '승인', exact: true }).click();
    const quick = page.getByRole('dialog', { name: '가입 승인' });
    await expect(quick).toBeVisible();
    await quick.locator('select').selectOption({ label: '고객사 관리자' });
    await quick.getByLabel('법인 하나 / 개발', { exact: true }).check();
    const [mapping] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/accounts/mapping')),
      quick.getByRole('button', { name: '승인', exact: true }).click(),
    ]);
    expect(mapping.status()).toBe(201);
    await expect(quick).toHaveCount(0);
    await expect(
      panel
        .locator('.ag-row')
        .filter({ hasText: code + '_applicant' })
        .getByText('승인 완료', { exact: true }),
    ).toBeVisible();
    // 매핑 탭은 저장된 부서를 보여 주고, 체크를 바꿔도 초기화하면 저장된 값으로 돌아간다.
    await page.getByRole('tab', { name: '법인·부서 매핑', exact: true }).click();
    await expect(toolbar.getByRole('button')).toHaveText(['초기화', '조회', '매핑 저장']);
    await panel.getByText(code + '_applicant', { exact: true }).click();
    await panel
      .getByLabel('법인 매핑', { exact: true })
      .getByText('법인 하나', { exact: true })
      .click();
    const mappedDept = panel.getByRole('checkbox', { name: '부서 매핑 행 선택 1', exact: true });
    await expect(mappedDept).toBeChecked();
    await mappedDept.click();
    await toolbar.getByRole('button', { name: '초기화', exact: true }).click();
    await expect(mappedDept).toBeChecked();
    // 승인과 부서 지정이 한 번에 끝났으므로 신청자는 바로 로그인할 수 있다.
    await signup.getByRole('button', { name: '로그인으로 돌아가기', exact: true }).click();
    await signup.getByLabel('아이디', { exact: true }).fill(code + '_applicant');
    await signup.getByLabel('비밀번호', { exact: true }).fill(password);
    await signup.getByRole('button', { name: '로그인', exact: true }).click();
    await expect(signup.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
    // 고객사 운영자에게는 고객사등록이 없고 법인/부서등록 및 사용자등록은 제공된다.
    await expect(
      signup.locator('aside').getByRole('button', { name: '고객사등록', exact: true }),
    ).toHaveCount(0);
    await signup.locator('aside').getByRole('button', { name: '사용자등록', exact: true }).click();
    await expect(signup.getByLabel('고객사', { exact: true })).toBeDisabled();
    await expect(signup.getByLabel('역할', { exact: true }).locator('option')).not.toContainText([
      '시스템 관리자',
    ]);
    await page.getByRole('tab', { name: '기본정보·승인', exact: true }).click();
    await expect(toolbar.getByRole('button')).toHaveText([
      '초기화',
      '조회',
      '저장',
      '삭제',
      '승인',
      '반려',
      '정지',
    ]);
    await toolbar.getByRole('button', { name: '초기화', exact: true }).click();
    await panel.getByLabel('아이디', { exact: true }).fill(code + '_direct');
    await panel.getByLabel('이름', { exact: true }).fill('직접 등록');
    await expect(panel.getByLabel('임시 비밀번호', { exact: false })).toHaveCount(0);
    await panel.getByLabel('이메일', { exact: true }).fill(code + '_direct@example.com');
    await panel.getByLabel('휴대전화번호', { exact: true }).fill('010-3333-4444');
    await panel.getByLabel('역할', { exact: true }).selectOption({ label: '고객사 관리자' });
    await toolbar.getByRole('button', { name: '저장', exact: true }).click();
    await expect(panel.getByLabel('아이디', { exact: true })).toHaveValue('');
    await expect(panel.getByText(code + '_direct', { exact: true })).toBeVisible();
    const u = (
      await db.query('SELECT id,account_status,password_hash FROM app.users WHERE login_id=$1', [
        code + '_direct',
      ])
    ).rows[0];
    expect(u.account_status).toBe('ACTIVE');
    expect(u.password_hash).toBeNull();
    const payload = (
      await db.query(
        "SELECT payload FROM app.mail_outbox WHERE user_id=$1 AND status='HELD' ORDER BY id DESC LIMIT 1",
        [u.id],
      )
    ).rows[0].payload;
    const link = openMail(payload).text.match(/http[^\s]+/)[0];
    const recovery = await browser.newPage();
    await recovery.goto(link);
    await expect(recovery.getByRole('heading', { name: '비밀번호 설정' })).toBeVisible();
    expect(recovery.url()).not.toContain('#account');
    await recovery.getByLabel('새 비밀번호', { exact: true }).fill(password);
    await recovery.getByLabel('새 비밀번호 확인', { exact: true }).fill(password);
    await recovery.getByRole('button', { name: '완료', exact: true }).click();
    await expect(recovery.getByRole('status').filter({ hasText: '처리를 완료' })).toBeVisible();
    await recovery.close();
    // 처리 중 줄(QA DL-006): 짧은 조회에서도 줄이 최소 0.6초 보인다.
    // 로컬 서버는 너무 빨라 줄이 아예 안 뜰 수 있으므로 조회의 첫 API 응답 하나만 0.3초 늦춰 QA가 본 상황(0.27초)을 만든다.
    // (모든 요청을 늦추면 조회가 여러 요청이라 처리 자체가 0.6초를 넘어 최소 시간 검사가 의미 없어진다.)
    let delayed = false;
    await page.route('**/api/**', async (route) => {
      if (!delayed) {
        delayed = true;
        await new Promise((r) => setTimeout(r, 300));
      }
      await route.continue();
    });
    await page.evaluate(() => {
      // MutationObserver: 화면 요소가 붙고 떨어지는 순간을 기록해 줄이 보인 시간을 잰다.
      // 줄(.progress-line)과 '처리 중…' 글자(.busy-note, 실제 처리 상태)를 함께 재서 비교한다.
      window.__seen = { line: {}, note: {} };
      new MutationObserver(() => {
        for (const [k, sel] of [
          ['line', '.progress-line'],
          ['note', '.busy-note'],
        ]) {
          const t = window.__seen[k],
            on = !!document.querySelector(sel);
          if (on && !t.shown) t.shown = performance.now();
          if (!on && t.shown && !t.hidden) t.hidden = performance.now();
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    await toolbar.getByRole('button', { name: '조회', exact: true }).click();
    await expect(toolbar.getByRole('button', { name: '조회', exact: true })).toBeEnabled();
    await expect(page.locator('.progress-line')).toHaveCount(0);
    const { line, note } = await page.evaluate(() => window.__seen);
    await page.unroute('**/api/**');
    expect(line.shown).toBeTruthy();
    // 기준 0.56초: 최소 0.6초에서 화면 그리기 지연(수십 ms)만큼 여유. 최소 시간이 없던 때는 이 조건에서 약 0.45초였다.
    const lineMs = line.hidden - line.shown;
    expect(lineMs).toBeGreaterThanOrEqual(560);
    // 줄은 실제 처리('처리 중…' 글자)가 끝나기 전에 사라지지 않는다.
    expect(line.hidden).toBeGreaterThanOrEqual(note.hidden);
    await panel.getByText(code + '_direct', { exact: true }).click();
    await expect(panel.getByLabel('아이디', { exact: true })).toHaveValue(code + '_direct');
    // 행을 고르기만 했을 때는 탭 제목에 '저장 안 한 변경(*)' 표시가 붙지 않는다(QA R3·DLV2-013).
    await expect(page.locator('.tab.active')).not.toContainText('*');
    await panel.getByLabel('이름', { exact: true }).fill('수정된 사용자');
    const [updated] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/accounts/update')),
      toolbar.getByRole('button', { name: '저장', exact: true }).click(),
    ]);
    expect(updated.status()).toBe(201);
    // 결과 알림에 대상 계정이 보인다(QA 5차 DV5-004).
    await expect(
      page.getByText(code + '_direct(수정된 사용자) 계정 정보를 변경했습니다.'),
    ).toBeVisible();
    await expect(panel.getByText('수정된 사용자', { exact: true })).toBeVisible();
    await expect(panel.getByText('매핑 필요', { exact: true })).toBeVisible();
    await panel.getByRole('checkbox', { name: '사용자 목록 행 선택 1', exact: true }).click();
    const [deleted] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/accounts/delete')),
      toolbar.getByRole('button', { name: '삭제', exact: true }).click(),
    ]);
    expect(deleted.status()).toBe(201);
    // 삭제 확인 창에 지울 계정이 '아이디(이름)'으로 적혀 있었다(QA 5차 DV5-002).
    expect(await page.evaluate(() => window.__confirms.at(-1))).toContain(
      code + '_direct(수정된 사용자) 사용자를 실제 삭제할까요?',
    );
    await expect(panel.getByText('수정된 사용자', { exact: true })).toHaveCount(0);
    expect(
      (await db.query('SELECT id FROM app.users WHERE login_id=$1', [code + '_direct'])).rowCount,
    ).toBe(0);
    expect(errors).toEqual([]);
    await mkdir(path.resolve(__dirname, '../../runtime'), { recursive: true });
    await page.screenshot({
      path: path.resolve(__dirname, '../../runtime/accounts-registration.png'),
    });
    console.log(
      'Catalog grids, signup without RESP, approval, tab buttons, mapping reset, profile and physical deletion passed.',
    );
  } catch (e) {
    if (page)
      await page
        .screenshot({ path: path.resolve(__dirname, '../../runtime/accounts-error.png') })
        .catch(() => {});
    throw e;
  } finally {
    if (browser) await browser.close();
    if (app) await app.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
