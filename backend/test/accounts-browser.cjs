/** 고객사 코드 등록 → 공개 가입 → 관리자 승인 → 직접 등록을 실제 화면으로 검증한다. 테스트 DB와 3002 포트를 사용한다. */
process.env.PGDATABASE = 'doneline_test';
// 테스트 중 실제 슬랙 알림이 나가지 않도록 빈 값으로 고정한다(.env보다 우선).
process.env.SLACK_WEBHOOK_URL = '';
process.env.APP_ORIGIN = 'http://127.0.0.1:3002';
const { chromium } = require('playwright');
const { expect } = require('playwright/test');
const { createApp } = require('../dist/app');
const { Db } = require('../dist/db');
const { openMail } = require('../dist/mail');
const argon2 = require('argon2');
const { randomBytes } = require('node:crypto');
const { mkdir } = require('node:fs/promises');
const path = require('node:path');
(async () => {
  let app, browser, page, signup;
  const code = 'browser_' + randomBytes(4).toString('hex'),
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
    page.on('dialog', (d) => d.accept());
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
    const token = (
      await db.query('SELECT signup_token FROM app.customers WHERE code=$1', [code])
    ).rows[0].signup_token;
    await signup.goto('http://127.0.0.1:3002/?signup=' + token);
    await signup.getByRole('button', { name: '회원가입', exact: true }).click();
    await expect(signup.getByText(code + ' · 브라우저 고객사', { exact: true })).toHaveCount(0);
    await signup.getByLabel('아이디', { exact: true }).fill(code + '_applicant');
    await signup.getByLabel('이름', { exact: true }).fill('가입 신청자');
    await signup.getByLabel('비밀번호', { exact: true }).fill(password);
    await signup.getByLabel('휴대전화번호', { exact: true }).fill('010-1111-2222');
    await signup.getByLabel('주소', { exact: true }).fill('서울');
    await signup.getByLabel('이메일', { exact: true }).fill(code + '@example.com');
    await expect(signup.getByLabel('RESP', { exact: true })).toHaveCount(0);
    await signup.getByRole('button', { name: '가입 신청', exact: true }).click();
    await expect(signup.getByRole('status').filter({ hasText: '가입 신청이 완료' })).toBeVisible();
    await page.locator('aside').getByRole('button', { name: '사용자등록', exact: true }).click();
    const panel = page.locator('.account-screen:visible');
    await panel
      .getByLabel('고객사', { exact: true })
      .selectOption({ label: code + ' · 브라우저 고객사' });
    await toolbar.getByRole('button', { name: '조회', exact: true }).click();
    await expect(panel.getByText(code + '_applicant', { exact: true })).toBeVisible();
    await expect(panel.getByLabel('승인 RESP', { exact: true })).toHaveCount(0);
    await panel.getByText(code + '_applicant', { exact: true }).click();
    await expect(panel.getByLabel('아이디', { exact: true })).toHaveValue(code + '_applicant');
    await panel
      .getByLabel('RESP', { exact: true })
      .selectOption({ label: 'CUSTOMER_MANAGER · 고객사 관리자 (레벨 10)' });
    const [assigned] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/accounts/update')),
      toolbar.getByRole('button', { name: '저장', exact: true }).click(),
    ]);
    expect(assigned.status()).toBe(201);
    await expect(panel.getByLabel('아이디', { exact: true })).toHaveValue(code + '_applicant');
    await panel.getByRole('checkbox', { name: '사용자 목록 행 선택 1', exact: true }).click();
    await toolbar.getByRole('button', { name: '승인', exact: true }).click();
    await expect(
      panel
        .locator('.ag-row')
        .filter({ hasText: code + '_applicant' })
        .getByText('승인 완료', { exact: true }),
    ).toBeVisible();
    // 승인만으로는 로그인되지 않는다. 두 번째 탭에서 법인과 실제 부서를 확정한다.
    await signup.getByRole('button', { name: '로그인으로 돌아가기', exact: true }).click();
    await signup.getByLabel('아이디', { exact: true }).fill(code + '_applicant');
    await signup.getByLabel('비밀번호', { exact: true }).fill(password);
    await signup.getByRole('button', { name: '로그인', exact: true }).click();
    await expect(signup.locator('.toast-error')).toContainText('아이디 또는 비밀번호');
    await page.getByRole('tab', { name: '법인·부서 매핑', exact: true }).click();
    await expect(toolbar.getByRole('button')).toHaveText(['초기화', '조회', '매핑 저장']);
    await panel.getByText(code + '_applicant', { exact: true }).click();
    await panel.getByRole('checkbox', { name: '법인 매핑 행 선택 1', exact: true }).click();
    await panel
      .getByLabel('법인 매핑', { exact: true })
      .getByText('법인 하나', { exact: true })
      .click();
    await panel.getByRole('checkbox', { name: '부서 매핑 행 선택 1', exact: true }).click();
    const [mapping] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/accounts/mapping')),
      toolbar.getByRole('button', { name: '매핑 저장', exact: true }).click(),
    ]);
    expect(mapping.status()).toBe(201);
    const mappedDept = panel.getByRole('checkbox', { name: '부서 매핑 행 선택 1', exact: true });
    await expect(mappedDept).toBeChecked();
    await mappedDept.click();
    await toolbar.getByRole('button', { name: '초기화', exact: true }).click();
    await expect(mappedDept).toBeChecked();
    await signup.getByRole('button', { name: '로그인', exact: true }).click();
    await expect(signup.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
    // 고객사 운영자에게는 고객사등록이 없고 법인/부서등록 및 사용자등록은 제공된다.
    await expect(
      signup.locator('aside').getByRole('button', { name: '고객사등록', exact: true }),
    ).toHaveCount(0);
    await signup.locator('aside').getByRole('button', { name: '사용자등록', exact: true }).click();
    await expect(signup.getByLabel('고객사', { exact: true })).toBeDisabled();
    await expect(signup.getByLabel('RESP', { exact: true }).locator('option')).not.toContainText([
      'ADMIN · 시스템 관리자',
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
    await panel
      .getByLabel('RESP', { exact: true })
      .selectOption({ label: 'CUSTOMER_MANAGER · 고객사 관리자 (레벨 10)' });
    await toolbar.getByRole('button', { name: '저장', exact: true }).click();
    await expect(panel.getByLabel('아이디', { exact: true })).toHaveValue('');
    await expect(panel.getByText(code + '_direct', { exact: true })).toBeVisible();
    const u = (
      await db.query(
        'SELECT id,account_status,password_hash FROM app.users WHERE login_id=$1',
        [code + '_direct'],
      )
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
    await toolbar.getByRole('button', { name: '조회', exact: true }).click();
    await expect(toolbar.getByRole('button', { name: '조회', exact: true })).toBeEnabled();
    await panel.getByText(code + '_direct', { exact: true }).click();
    await expect(panel.getByLabel('아이디', { exact: true })).toHaveValue(code + '_direct');
    await panel.getByLabel('이름', { exact: true }).fill('수정된 사용자');
    const [updated] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/accounts/update')),
      toolbar.getByRole('button', { name: '저장', exact: true }).click(),
    ]);
    expect(updated.status()).toBe(201);
    await expect(panel.getByText('수정된 사용자', { exact: true })).toBeVisible();
    await expect(panel.getByText('매핑 필요', { exact: true })).toBeVisible();
    await panel.getByRole('checkbox', { name: '사용자 목록 행 선택 1', exact: true }).click();
    const [deleted] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/accounts/delete')),
      toolbar.getByRole('button', { name: '삭제', exact: true }).click(),
    ]);
    expect(deleted.status()).toBe(201);
    await expect(panel.getByText('수정된 사용자', { exact: true })).toHaveCount(0);
    expect(
      (await db.query('SELECT id FROM app.users WHERE login_id=$1', [code + '_direct']))
        .rowCount,
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
