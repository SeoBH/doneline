/**
 * 독립 화면·메뉴·RESP 등록의 브라우저 검증. 테스트 계정과 별도 서버로 실제 입력·저장·연결·탭 조작을 수행하고 DB 결과를 비교한다.
 */
process.env.PGDATABASE = 'doneline_test';
// 테스트 중 실제 슬랙 알림이 나가지 않도록 빈 값으로 고정한다(.env보다 우선).
process.env.SLACK_WEBHOOK_URL = '';
process.env.APP_ORIGIN = 'http://127.0.0.1:3001';
const { chromium } = require('playwright');
const { expect } = require('playwright/test');
const { createApp } = require('../dist/app');
const { Db } = require('../dist/db');
const { randomBytes } = require('node:crypto');
const argon2 = require('argon2');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  let app, browser, page;
  try {
    app = await createApp();
    const db = app.get(Db),
      name = 'ui_reg_' + randomBytes(4).toString('hex'),
      password = randomBytes(24).toString('hex');
    // 테스트 준비 SQL은 HTTP 요청 밖에서 실행되므로 운영 워크스페이스를 기본 범위로 지정한다.
    db.useScriptWorkspace(await db.platformWorkspaceId());
    await db.query("DELETE FROM app.login_limits WHERE bucket LIKE 'ip:%'");
    const root = (
      await db.query('INSERT INTO app.menus(code,name) VALUES($1,$1) RETURNING id', [name])
    ).rows[0].id;
    const resp = (
      await db.query(
        "INSERT INTO app.responsibilities(code,name,root_menu_id,authority_type) VALUES($1,$1,$2,'SYSTEM') RETURNING id",
        [name, root],
      )
    ).rows[0].id;
    await db.query(
      'INSERT INTO app.users(login_id,password_hash,display_name,resp_id,must_change_password) VALUES($1,$2,$1,$3,false)',
      [name, await argon2.hash(password), resp],
    );
    for (const code of ['SCREEN_REGISTER', 'MENU_REGISTER', 'RESP_REGISTER', 'AUDIT']) {
      const screen = (await db.query('SELECT id FROM app.screens WHERE code=$1', [code])).rows[0]
        .id;
      const map = (
        await db.query(
          'INSERT INTO app.menu_screens(menu_id,screen_id) VALUES($1,$2) RETURNING id',
          [root, screen],
        )
      ).rows[0].id;
      for (const action of ['RESET', 'QUERY', 'SAVE', 'DELETE'])
        await db.query('INSERT INTO app.menu_screen_buttons VALUES($1,$2,true)', [map, action]);
    }
    await app.listen(3001, '127.0.0.1');
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    page = await browser.newPage({ viewport: { width: 1700, height: 1050 } });
    const errors = [],
      dialogs = [];
    page.on('pageerror', (e) => {
      errors.push(e.message);
      console.error(e.message);
    });
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      d.accept();
    });
    await page.goto('http://127.0.0.1:3001');
    await page.getByLabel('아이디').fill(name);
    await page.getByLabel('비밀번호', { exact: true }).fill('incorrect-password');
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await expect(page.locator('.toast-error')).toContainText('아이디 또는 비밀번호');
    await page.getByLabel('비밀번호', { exact: true }).fill(password);
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    const splitter = page.getByRole('separator', { name: '사이드메뉴 너비', exact: true });
    await expect(splitter).toHaveAttribute('aria-valuenow', '220');
    const splitBox = await splitter.boundingBox();
    await page.mouse.move(splitBox.x + 4, splitBox.y + 100);
    await page.mouse.down();
    await page.mouse.move(splitBox.x + 154, splitBox.y + 100, { steps: 10 });
    await page.mouse.up();
    await expect(splitter).toHaveAttribute('aria-valuenow', '370');
    await splitter.dblclick();
    await expect(splitter).toHaveAttribute('aria-valuenow', '8');
    await expect(page.locator('aside')).toBeHidden();
    await splitter.dblclick();
    await expect(splitter).toHaveAttribute('aria-valuenow', '370');
    await expect(page.locator('aside')).toBeVisible();
    await splitter.press('Home');
    await expect(page.locator('aside')).toBeHidden();
    await splitter.press('Enter');
    await expect(splitter).toHaveAttribute('aria-valuenow', '370');
    // 휴대폰 폭에서는 사이드 메뉴가 ☰ 버튼으로 여닫는 덮개가 되고 너비 조절 손잡이는 숨긴다.
    await page.setViewportSize({ width: 640, height: 900 });
    await expect(page.getByRole('button', { name: '메뉴 열기', exact: true })).toBeVisible();
    await expect(splitter).toBeHidden();
    await page.setViewportSize({ width: 1700, height: 1050 });
    await expect(splitter).toHaveAttribute('aria-valuenow', '370');
    const resizedBox = await splitter.boundingBox();
    await page.mouse.move(resizedBox.x + 4, resizedBox.y + 100);
    await page.mouse.down();
    await page.mouse.move(resizedBox.x - 146, resizedBox.y + 100, { steps: 10 });
    await page.mouse.up();
    await expect(splitter).toHaveAttribute('aria-valuenow', '220');
    await expect(page.locator('.work>.status')).toHaveCount(0);
    const open = async (title) =>
      page.locator('aside').getByRole('button', { name: title, exact: true }).click();
    const check = async (locator) => {
      await locator.click();
      await expect(locator).toBeChecked();
    };
    const tool = page.locator('.toolbar');
    const active = () => page.locator('.content>div:not([hidden])');
    const edit = async (grid, key, col, value) => {
      const cell = grid.locator('.ag-row[row-id="' + key + '"] [col-id="' + col + '"]');
      await cell.dblclick();
      await cell.locator('input').fill(value);
      await cell.locator('input').press('Enter');
    };
    const newRow = async () => {
      const rows = active().locator('.register-left .ag-row');
      const previous = await rows.count();
      await active()
        .locator('.register-left')
        .getByRole('button', { name: '행추가', exact: true })
        .click();
      await expect(rows).toHaveCount(previous + 1);
      return rows.last().getAttribute('row-id');
    };
    const requestClick = async (locator, part) => {
      const [r] = await Promise.all([
        page.waitForResponse((r) => r.url().includes(part) && r.request().method() === 'POST'),
        locator.click(),
      ]);
      assert.equal(r.status(), 201, await r.text());
      await tool.getByRole('button', { name: '저장', exact: true }).waitFor({ state: 'visible' });
      await page.waitForFunction(() => !document.querySelector('.toolbar button:disabled'));
      return r.json();
    };
    await open('메뉴등록');
    await tool.getByRole('button', { name: '조회', exact: true }).click();
    const successToast = page.locator('.toast-success').filter({ hasText: '조회했습니다.' });
    await expect(successToast).toHaveCount(1);
    // Reading a notification keeps it visible; leaving lets it expire automatically.
    await successToast.hover();
    await page.waitForTimeout(4200);
    await expect(successToast).toBeVisible();
    await page.mouse.move(20, 20);
    await expect(successToast).toHaveCount(0, { timeout: 6000 });
    await tool.getByRole('button', { name: '조회', exact: true }).click();
    await expect(successToast).toHaveCount(1);
    // 같은 종류·문구의 알림은 쌓지 않고 하나로 갱신한다(입력칸 가림 방지).
    await tool.getByRole('button', { name: '조회', exact: true }).click();
    await expect(successToast).toHaveCount(1);
    await successToast.first().getByRole('button', { name: '알림 닫기' }).click();
    await expect(successToast).toHaveCount(0);
    await tool.getByRole('button', { name: '초기화', exact: true }).click();
    await active()
      .locator('.register-left .query-bar')
      .getByLabel('메뉴코드', { exact: true })
      .fill(name + '_menu');
    let key = await newRow();
    const left = active().locator('[aria-label="메뉴 등록"]');
    await expect(
      left.getByRole('checkbox', { name: '메뉴 등록 행 선택 1', exact: true }),
    ).toBeChecked();
    await edit(left, key, 'code', name + '_menu');
    await edit(left, key, 'name', '브라우저 메뉴');
    await left.locator('.ag-row').click();
    await expect(
      active().locator('.fixed-bar').getByLabel('메뉴코드', { exact: true }),
    ).toHaveValue('');
    await expect(active().getByRole('button', { name: '메뉴적용', exact: true })).toBeDisabled();
    const saved = await requestClick(
        tool.getByRole('button', { name: '저장', exact: true }),
        '/menus/save',
      ),
      menu = saved.items[0].item;
    key = menu.id;
    await expect(
      left.getByRole('checkbox', { name: '메뉴 등록 행 선택 1', exact: true }),
    ).not.toBeChecked();
    // Persisted code cannot enter edit mode; changes check the row.
    await left.locator('.ag-row [col-id="code"]').dblclick();
    await expect(left.locator('.ag-cell-inline-editing')).toHaveCount(0);
    await edit(left, key, 'name', '저장 전 메뉴명');
    await expect(
      left.getByRole('checkbox', { name: '메뉴 등록 행 선택 1', exact: true }),
    ).toBeChecked();
    await left.locator('.ag-row [col-id="name"]').click();
    await page.waitForFunction(() => document.querySelector('.fixed-bar input')?.value !== '');
    await expect(active().locator('.fixed-bar').getByLabel('메뉴명', { exact: true })).toHaveValue(
      '브라우저 메뉴',
    );
    // Candidate appears in layout only after Add; DB remains unchanged until Apply.
    const candidate = active().locator('[aria-label="화면 후보"]');
    await check(candidate.getByRole('checkbox', { name: '화면 후보 행 선택 1', exact: true }));
    await active()
      .locator('.candidate-panels>section')
      .nth(1)
      .getByRole('button', { name: '추가', exact: true })
      .click();
    await expect(active().locator('[aria-label="하위 구성"] .ag-row')).toHaveCount(1);
    assert.equal(
      (await db.query('SELECT count(*)::int n FROM app.menu_screens WHERE menu_id=$1', [menu.id]))
        .rows[0].n,
      0,
    );
    await requestClick(
      active().getByRole('button', { name: '메뉴적용', exact: true }),
      '/menus/' + menu.id + '/apply',
    );
    assert.equal(
      (await db.query('SELECT count(*)::int n FROM app.menu_screens WHERE menu_id=$1', [menu.id]))
        .rows[0].n,
      1,
    );
    await check(
      active()
        .locator('[aria-label="하위 구성"]')
        .getByRole('checkbox', { name: '하위 구성 행 선택 1', exact: true }),
    );
    await active()
      .locator('.register-right>.grid-tools')
      .getByRole('button', { name: '행삭제', exact: true })
      .click();
    await page.waitForFunction(() => !document.querySelector('.toolbar button:disabled'));
    await expect(active().locator('[aria-label="하위 구성"] .ag-row')).toHaveCount(0);
    assert.equal(
      (await db.query('SELECT count(*)::int n FROM app.menu_screens WHERE menu_id=$1', [menu.id]))
        .rows[0].n,
      1,
    );
    await page.screenshot({ path: path.resolve(__dirname, '../../runtime/menu-registration.png') });
    // A new unsaved left row clears right data; close discards without a dialog.
    await newRow();
    await left.locator('.ag-row').last().click();
    await expect(
      active().locator('.fixed-bar').getByLabel('메뉴코드', { exact: true }),
    ).toHaveValue('');
    const beforeClose = dialogs.length;
    await page.getByRole('button', { name: '메뉴등록 닫기', exact: true }).click();
    assert.equal(dialogs.length, beforeClose);
    await open('화면등록');
    await active()
      .locator('.register-left .query-bar')
      .getByLabel('화면코드', { exact: true })
      .fill(name);
    let sk = await newRow();
    const sg = active().locator('[aria-label="화면 등록"]');
    await edit(sg, sk, 'code', name + '_screen');
    await edit(sg, sk, 'name', '브라우저 화면');
    await edit(sg, sk, 'component_key', 'sample');
    await check(sg.getByRole('checkbox', { name: '화면 등록 조회 1', exact: true }));
    const screenSaved = await requestClick(
      tool.getByRole('button', { name: '저장', exact: true }),
      '/screens/save',
    );
    sk = screenSaved.items[0].id;
    assert.equal(screenSaved.items[0].item.buttons.QUERY, true);
    await page.screenshot({
      path: path.resolve(__dirname, '../../runtime/screen-registration.png'),
    });
    // Invalid second row cancels whole batch while both drafts remain.
    const s2 = await newRow();
    await edit(sg, s2, 'code', name + '_invalid');
    await edit(sg, s2, 'name', 'Missing source');
    await edit(sg, sk, 'name', '취소될 수정');
    const [bad] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/screens/save') && r.request().method() === 'POST',
      ),
      tool.getByRole('button', { name: '저장', exact: true }).click(),
    ]);
    assert.equal(bad.status(), 400);
    await expect(page.locator('.toast-error')).toContainText('2행');
    await expect(active().locator('.row-errors')).toHaveCount(0);
    await expect(sg.locator('.grid-row-error')).toHaveCount(1);
    await expect(sg.locator('.ag-row')).toHaveCount(2);
    assert.equal(
      (await db.query('SELECT name FROM app.screens WHERE id=$1', [screenSaved.items[0].id]))
        .rows[0].name,
      '브라우저 화면',
    );
    // 체크하지 않은 신규 행과 기존 행의 수정은 성공 후 DB 재조회로 버린다.
    await sg.getByRole('checkbox', { name: '화면 등록 행 선택 1', exact: true }).click();
    await sg.getByRole('checkbox', { name: '화면 등록 행 선택 2', exact: true }).click();
    const s3 = await newRow();
    await edit(sg, s3, 'code', name + '_screen2');
    await edit(sg, s3, 'name', '두 번째 화면');
    await edit(sg, s3, 'component_key', 'sample');
    await requestClick(tool.getByRole('button', { name: '저장', exact: true }), '/screens/save');
    await expect(sg.locator('.ag-row')).toHaveCount(2);
    await expect(sg.getByText('브라우저 화면', { exact: true })).toBeVisible();
    await expect(sg.getByText('Missing source', { exact: true })).toHaveCount(0);
    await sg.getByText('브라우저 화면', { exact: true }).click();
    await sg.getByText('두 번째 화면', { exact: true }).click();
    await expect(sg.locator('.grid-row-current')).toHaveCount(1);
    await expect(sg.locator('.grid-row-current')).toContainText('두 번째 화면');
    await open('RESP등록');
    await active()
      .locator('.register-left .query-bar')
      .getByLabel('RESP코드', { exact: true })
      .fill(name + '_resp');
    const rk = await newRow(),
      rg = active().locator('[aria-label="RESP 등록"]');
    await edit(rg, rk, 'code', name + '_resp');
    await edit(rg, rk, 'name', '브라우저 RESP');
    const respSaved = await requestClick(
      tool.getByRole('button', { name: '저장', exact: true }),
      '/responsibilities/save',
    );
    assert.equal(respSaved.items[0].item.root_menu_id, null);
    await rg.locator('.ag-row').click();
    const candidates = active().locator('[aria-label="메뉴 후보"]');
    await candidates.locator('.ag-row').first().waitFor();
    await candidates.locator('.ag-row').first().click();
    await requestClick(
      active().getByRole('button', { name: '적용', exact: true }),
      '/responsibilities/' + respSaved.items[0].id + '/apply',
    );
    await page.screenshot({ path: path.resolve(__dirname, '../../runtime/resp-registration.png') });
    const count = dialogs.length;
    await tool.getByRole('button', { name: '초기화', exact: true }).click();
    assert.equal(dialogs.length, count);
    // All tabs close at the mouse context menu, with no discard prompt.
    const tab = page.locator('footer .tab').first(),
      box = await tab.boundingBox();
    await tab.click({ button: 'right' });
    const popup = page.getByRole('menu', { name: '탭 작업' });
    const popupBox = await popup.boundingBox();
    assert.ok(popupBox.x >= 0 && popupBox.y >= 0);
    assert.ok(Math.abs(popupBox.x - (box.x + box.width / 2)) < 10);
    await popup.getByRole('menuitem', { name: '전체 닫기', exact: true }).click();
    await expect(page.locator('footer .tab')).toHaveCount(0);
    assert.equal(dialogs.length, count);
    assert.deepEqual(errors, []);
    console.log(
      'Browser registration, atomic rollback, saved-value selection, draft mapping, RESP apply and tab close passed.',
    );
  } catch (e) {
    if (page) {
      await page.screenshot({
        path: path.resolve(__dirname, '../../runtime/registration-error.png'),
      });
      require('node:fs').writeFileSync(
        path.resolve(__dirname, '../../runtime/registration-error.html'),
        await page.content(),
      );
    }
    throw e;
  } finally {
    if (browser) await browser.close();
    if (app) await app.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
