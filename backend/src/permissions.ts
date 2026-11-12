/**
 * RESP의 시작 메뉴에서 도달 가능한 화면·버튼 권한을 계산한다.
 * DB 권한 버전이 바뀌면 캐시를 재생성한다.
 * hidden은 표시 설정이며 권한 취소를 의미하지 않는다.
 */
import { Injectable } from '@nestjs/common';
import { Db } from './db';
@Injectable()
export class Permissions {
  private readonly cache = new Map<string, { version: string; allowed: Set<string> }>();
  constructor(private readonly db: Db) {}
  async allows(resp: string, menu: string, screen: string, action: string) {
    const version = (
      await this.db.query('SELECT version FROM app.authorization_state WHERE id=1')
    ).rows[0].version;
    let cached = this.cache.get(resp);
    if (!cached || cached.version !== version) {
      // 버전과 권한 목록을 같은 스냅샷에서 읽어 다른 시점의 데이터를 캐시하지 않는다.
      cached = await this.db.snapshot(async (c) => {
        const v = (await c.query('SELECT version FROM app.authorization_state WHERE id=1')).rows[0]
          .version;
        const { rows } = await c.query(
          `WITH RECURSIVE reachable(id) AS (
     SELECT m.id FROM app.responsibilities r JOIN app.menus m ON m.id=r.root_menu_id AND m.is_active WHERE r.id=$1 AND r.is_active
     UNION SELECT e.child_menu_id FROM app.menu_edges e JOIN reachable p ON e.parent_menu_id=p.id JOIN app.menus m ON m.id=e.child_menu_id AND m.is_active)
     SELECT r.id AS menu,s.code, sb.action_code FROM reachable r JOIN app.menu_screens ms ON ms.menu_id=r.id
     JOIN app.screens s ON s.id=ms.screen_id AND s.is_active
     JOIN app.screen_buttons sb ON sb.screen_id=s.id AND sb.is_used
     JOIN app.menu_screen_buttons mb ON mb.menu_screen_id=ms.id AND mb.action_code=sb.action_code AND mb.is_allowed`,
          [resp],
        );
        return {
          version: v,
          allowed: new Set<string>(rows.map((r) => [r.menu, r.code, r.action_code].join(':'))),
        };
      });
      // Bound process memory. DB remains the source of truth across instances.
      if (this.cache.size >= 1000) this.cache.clear();
      this.cache.set(resp, cached);
    }
    return cached.allowed.has([menu, screen, action].join(':'));
  }
}
