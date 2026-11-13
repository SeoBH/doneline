/**
 * 최초 관리자와 관리 메뉴·화면·버튼을 생성한다.
 * 기존 코드는 보존하고 새 관리자 생성 시에만 초기 비밀번호를 .env.bootstrap에 기록한다.
 */
import { Db } from './db';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as argon2 from 'argon2';
async function seed() {
  const db = new Db();
  try {
    const password = randomBytes(24).toString('base64url'),
      hash = await argon2.hash(password);
    // 최초 관리자와 ADMIN RESP는 운영 워크스페이스 소속이다. 요청 밖 스크립트이므로 기본 범위를 직접 지정한다.
    db.useScriptWorkspace(await db.platformWorkspaceId());
    const created = await db.tx(async (c) => {
      await c.query(
        "INSERT INTO app.menus(code,name) VALUES('ROOT','관리') ON CONFLICT(code) DO NOTHING",
      );
      const menu = (await c.query("SELECT id FROM app.menus WHERE code='ROOT'")).rows[0].id;
      await c.query(
        // ADMIN은 화면·메뉴 구성 권한을 포함하므로 공통(NULL)이 아닌 운영 워크스페이스 전용 RESP로 만든다.
        "INSERT INTO app.responsibilities(code,name,root_menu_id,authority_type,level,workspace_id) VALUES('ADMIN','시스템 관리자',$1,'SYSTEM',0,app.current_workspace_id()) ON CONFLICT(code) DO NOTHING",
        [menu],
      );
      const resp = (await c.query("SELECT id FROM app.responsibilities WHERE code='ADMIN'")).rows[0]
        .id;
      await c.query(
        "INSERT INTO app.screens(code,name,purpose,component_key) VALUES('AUDIT','감사 로그','로그인과 업무 처리 이력','audit') ON CONFLICT(code) DO NOTHING",
      );
      const screen = (await c.query("SELECT id FROM app.screens WHERE code='AUDIT'")).rows[0].id;
      await c.query(
        "INSERT INTO app.screen_buttons VALUES($1,'QUERY','조회',true) ON CONFLICT DO NOTHING",
        [screen],
      );
      await c.query(
        'INSERT INTO app.menu_screens(menu_id,screen_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [menu, screen],
      );
      const mapping = (
        await c.query('SELECT id FROM app.menu_screens WHERE menu_id=$1 AND screen_id=$2', [
          menu,
          screen,
        ])
      ).rows[0].id;
      await c.query(
        "INSERT INTO app.menu_screen_buttons VALUES($1,'QUERY',true) ON CONFLICT DO NOTHING",
        [mapping],
      );
      for (const [i, [code, name, key]] of [
        ['SCREEN_REGISTER', '화면등록', 'screen-register'],
        ['MENU_REGISTER', '메뉴등록', 'menu-register'],
        ['RESP_REGISTER', 'RESP등록', 'resp-register'],
        ['USER_REGISTER', '사용자등록', 'user-register'],
        ['CUSTOMER_REGISTER', '고객사등록', 'customer-register'],
        ['CORPORATION_REGISTER', '법인등록', 'corporation-register'],
        ['DEPARTMENT_REGISTER', '부서등록', 'department-register'],
      ].entries()) {
        await c.query(
          'INSERT INTO app.screens(code,name,component_key) VALUES($1,$2,$3) ON CONFLICT(code) DO NOTHING',
          [code, name, key],
        );
        const configScreen = (await c.query('SELECT id FROM app.screens WHERE code=$1', [code]))
          .rows[0].id;
        await c.query(
          'INSERT INTO app.menu_screens(menu_id,screen_id,sort_order) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [menu, configScreen, 10 + i],
        );
        const configMap = (
          await c.query('SELECT id FROM app.menu_screens WHERE menu_id=$1 AND screen_id=$2', [
            menu,
            configScreen,
          ])
        ).rows[0].id;
        for (const [action, label] of [
          ['RESET', '초기화'],
          ['QUERY', '조회'],
          ['SAVE', '저장'],
          ['DELETE', '삭제'],
          ['ETC1', '기타1'],
          ['ETC2', '기타2'],
          ['ETC3', '기타3'],
          ['ETC4', '기타4'],
        ]) {
          const used =
            code === 'USER_REGISTER'
              ? true
              : code === 'CUSTOMER_REGISTER'
                ? ['RESET', 'QUERY', 'SAVE', 'DELETE'].includes(action)
                : !action.startsWith('ETC');
          await c.query(
            'INSERT INTO app.screen_buttons VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
            [configScreen, action, label, used],
          );
          await c.query(
            'INSERT INTO app.menu_screen_buttons VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
            [configMap, action, used],
          );
        }
      }
      // 마이그레이션(014~016)이 만든 업무·운영 화면도 운영 관리자 메뉴(ROOT)에 연결한다.
      // 새 환경에서는 마이그레이션이 seed보다 먼저 실행되어 그때는 ROOT 메뉴가 없으므로 연결이 빠지기 때문이다.
      // 버튼 허용은 화면에서 사용 중인 버튼과 같게 맞춘다. 이미 연결되어 있으면 아무것도 바꾸지 않는다.
      for (const [code, sort] of [
        ['SR_DESK', 1],
        ['SR_REPORT', 2],
        ['SLA_SETTINGS', 30],
        ['FEEDBACK_INBOX', 95],
      ] as const) {
        const screen = (await c.query('SELECT id FROM app.screens WHERE code=$1', [code])).rows[0];
        if (!screen) continue;
        await c.query(
          'INSERT INTO app.menu_screens(menu_id,screen_id,sort_order) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [menu, screen.id, sort],
        );
        await c.query(
          `INSERT INTO app.menu_screen_buttons(menu_screen_id,action_code,is_allowed)
           SELECT ms.id,b.action_code,b.is_used FROM app.menu_screens ms JOIN app.screen_buttons b ON b.screen_id=ms.screen_id
           WHERE ms.menu_id=$1 AND ms.screen_id=$2 ON CONFLICT DO NOTHING`,
          [menu, screen.id],
        );
      }

      const inserted = await c.query(
        "INSERT INTO app.users(login_id,password_hash,display_name,resp_id) VALUES('admin',$1,'관리자',$2) ON CONFLICT(login_id) DO NOTHING RETURNING id",
        [hash, resp],
      );
      return Boolean(inserted.rowCount);
    });
    if (created && !process.env.PGDATABASE?.endsWith('_test')) {
      await writeFile(
        resolve(__dirname, '../../.env.bootstrap'),
        'BOOTSTRAP_LOGIN=admin\nBOOTSTRAP_PASSWORD=' + password + '\n',
        { mode: 0o600, flag: 'wx' },
      );
      console.log('Administrator created. Credentials: .env.bootstrap (local only).');
    } else
      console.log(
        created
          ? 'Test administrator created; no bootstrap file written.'
          : 'Administrator already exists; password preserved.',
      );
  } finally {
    await db.onModuleDestroy();
  }
}
seed().catch(() => {
  console.error('Seed failed');
  process.exitCode = 1;
});
