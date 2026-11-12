/** 공통 코드검색의 선택·검색·취소·늦은 응답을 검증한다. Vite 테스트 페이지와 Edge만 사용하고 DB를 변경하지 않는다. */
const { chromium } = require('playwright');
const { expect } = require('playwright/test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
(async () => {
  let server, browser;
  try {
    const { createServer } = await import(
      pathToFileURL(path.resolve(__dirname, '../../frontend/node_modules/vite/dist/node/index.js'))
        .href
    );
    server = await createServer({
      root: path.resolve(__dirname, '../../frontend'),
      server: { host: '127.0.0.1', port: 3003, strictPort: true },
    });
    await server.listen();
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } }),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('http://127.0.0.1:3003/test/lookup.html');
    const opener = page.getByRole('button', { name: '업무 테스트 법인코드 검색 1', exact: true }),
      dialog = page.getByRole('dialog', { name: '법인검색' });
    const state = async () => JSON.parse(await page.getByTestId('rows').textContent());
    await opener.click();
    await expect(dialog.getByRole('status')).toHaveText('4건');
    await dialog.getByLabel('코드', { exact: true }).fill('a00');
    await dialog.getByLabel('명칭', { exact: true }).fill('부산');
    await dialog.getByRole('button', { name: '조회', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveText('1건');
    await dialog.getByText('부산전자', { exact: true }).dblclick();
    await expect(dialog).toHaveCount(0);
    let rows = await state();
    expect(rows[0]).toMatchObject({
      corporation_id: '2',
      corporation_code: 'A002',
      corporation_name: '부산전자',
      department_id: '',
      department_code: '',
      department_name: '',
      _checked: true,
    });
    expect(rows[1]).toMatchObject({ corporation_id: '3', department_id: 'd2' });
    await expect(opener).toBeFocused();
    const saved = JSON.stringify(rows);
    await opener.click();
    await dialog.getByText('서울전자', { exact: true }).click();
    await dialog.getByRole('button', { name: '취소' }).click();
    expect(JSON.stringify(await state())).toBe(saved);
    await opener.click();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(JSON.stringify(await state())).toBe(saved);
    await page.getByRole('button', { name: '테스트 초기화' }).click();
    await opener.click();
    await dialog.getByText('서울전자', { exact: true }).click();
    await dialog.getByRole('button', { name: '선택', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect((await state())[0].department_id).toBe('d1');
    await opener.click();
    await dialog.getByLabel('코드', { exact: true }).fill('없는코드');
    await dialog.getByLabel('코드', { exact: true }).press('Enter');
    await expect(dialog.getByRole('status')).toHaveText('0건');
    await expect(dialog.getByRole('button', { name: '선택', exact: true })).toBeDisabled();
    await dialog.getByLabel('코드', { exact: true }).fill('_');
    await dialog.getByRole('button', { name: '조회', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveText('1건');
    await dialog.getByText('100% 법인', { exact: true }).dblclick();
    await expect(dialog).toHaveCount(0);
    expect((await state())[0].corporation_code).toBe('P_01');
    await page.getByLabel('응답 모드').selectOption('error');
    await opener.click();
    await expect(dialog.getByRole('alert')).toContainText('테스트 조회 실패');
    await expect(dialog.getByRole('button', { name: '선택', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: '취소' }).click();
    await page.getByLabel('응답 모드').selectOption('slow');
    await opener.click();
    await dialog.getByRole('button', { name: '취소' }).click();
    await page.waitForTimeout(500);
    await expect(dialog).toHaveCount(0);
    await page.getByLabel('응답 모드').selectOption('replace');
    await opener.click();
    await expect(dialog).toHaveCount(0);
    await page.waitForTimeout(500);
    expect((await state())[0].corporation_code).toBe('A001');
    await page.getByRole('button', { name: '편집 잠금' }).click();
    await expect(opener).toBeDisabled();
    expect(errors).toEqual([]);
    console.log(
      'Lookup search, double-click, select, cancel, focus, dependency clearing and stale responses passed.',
    );
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
