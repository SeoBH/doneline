/**
 * RESP에 속한 메뉴 그래프와 화면·버튼 정보를 반환하고 감사 로그 조회 API를 제공한다.
 * 여러 부모가 같은 메뉴를 공유할 수 있으며 트리 표시는 프런트가 담당한다.
 */
import { Controller, Get, Injectable, Param, ParseUUIDPipe, Query, Req } from '@nestjs/common';
import { Db } from './db';
import { Audit } from './audit';
import { AppRequest, Permission } from './security';
@Injectable()
export class NavigationService {
  constructor(private readonly db: Db) {}
  async tree(respId: string) {
    return this.db.snapshot(async (c) => {
      const root = (
        await c.query('SELECT root_menu_id FROM app.responsibilities WHERE id=$1', [respId])
      ).rows[0].root_menu_id;
      const menus = (
        await c.query(
          `WITH RECURSIVE reachable(id) AS (
    SELECT id FROM app.menus WHERE id=$1 AND is_active
    UNION SELECT e.child_menu_id FROM app.menu_edges e JOIN reachable r ON r.id=e.parent_menu_id JOIN app.menus m ON m.id=e.child_menu_id AND m.is_active)
    SELECT m.id,m.name FROM app.menus m JOIN reachable r ON m.id=r.id ORDER BY m.id`,
          [root],
        )
      ).rows;
      const ids = menus.map((m) => m.id);
      const edges = (
        await c.query(
          'SELECT parent_menu_id,child_menu_id,sort_order,hidden FROM app.menu_edges WHERE parent_menu_id=ANY($1::bigint[]) AND child_menu_id=ANY($1::bigint[]) ORDER BY sort_order,child_menu_id',
          [ids],
        )
      ).rows;
      const screens = (
        await c.query(
          `SELECT ms.menu_id,s.id,s.code,s.name,s.component_key,ms.sort_order,ms.hidden,
    COALESCE(jsonb_object_agg(sb.action_code,jsonb_build_object('label',sb.label,'allowed',sb.is_used AND COALESCE(mb.is_allowed,false))) FILTER(WHERE sb.action_code IS NOT NULL),'{}') AS buttons
    FROM app.menu_screens ms JOIN app.screens s ON s.id=ms.screen_id AND s.is_active
    LEFT JOIN app.screen_buttons sb ON sb.screen_id=s.id
    LEFT JOIN app.menu_screen_buttons mb ON mb.menu_screen_id=ms.id AND mb.action_code=sb.action_code
    WHERE ms.menu_id=ANY($1::bigint[]) GROUP BY ms.id,s.id ORDER BY ms.sort_order,s.id`,
          [ids],
        )
      ).rows;
      return { rootMenuId: root || '', menus, edges, screens };
    });
  }
}
@Controller('api')
export class NavigationController {
  constructor(
    private readonly nav: NavigationService,
    private readonly db: Db,
    private readonly audit: Audit,
  ) {}
  @Get('navigation')
  async navigation(@Req() req: AppRequest) {
    const result = await this.nav.tree(req.actor!.resp_id);
    if (req.actor!.authority_type !== 'SYSTEM')
      result.screens = result.screens.filter(
        (s) =>
          ![
            'SCREEN_REGISTER',
            'MENU_REGISTER',
            'RESP_REGISTER',
            'AUDIT',
            'CUSTOMER_REGISTER',
            'SR_DESK',
            'SLA_SETTINGS',
            'SR_REPORT',
          ].includes(s.code),
      );
    // 공통 구성 화면은 운영 워크스페이스만 사용할 수 있으므로(security.ts) 다른 업체 메뉴에서는 보이지 않게 한다.
    else if (!req.actor!.is_platform)
      result.screens = result.screens.filter(
        (s) => !['SCREEN_REGISTER', 'MENU_REGISTER', 'RESP_REGISTER'].includes(s.code),
      );
    await this.audit.write({
      requestId: req.requestId,
      userId: req.actor!.id,
      action: 'NAVIGATION',
      outcome: 'SUCCESS',
    });
    return result;
  }
  @Get('admin/audit-events/:id/changes')
  @Permission('AUDIT', 'QUERY')
  async changes(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    const result = await this.db.query(
      'SELECT * FROM audit.config_changes WHERE event_id=$1 ORDER BY id',
      [id],
    );
    await this.audit.write({
      requestId: req.requestId,
      userId: req.actor!.id,
      menuId: req.get('x-menu-id'),
      action: 'AUDIT_DETAIL',
      outcome: 'SUCCESS',
    });
    return { items: result.rows };
  }
  @Get('admin/audit-events')
  @Permission('AUDIT', 'QUERY')
  async events(@Req() req: AppRequest, @Query('page') page = '1') {
    const index = /^\d{1,5}$/.test(page) ? Math.max(1, Number(page)) : 1;
    const result = await this.db.query(
      'SELECT * FROM audit.event_summary ORDER BY occurred_at DESC,event_id DESC LIMIT 50 OFFSET $1',
      [(index - 1) * 50],
    );
    await this.audit.write({
      requestId: req.requestId,
      userId: req.actor!.id,
      menuId: req.get('x-menu-id'),
      action: 'AUDIT_QUERY',
      outcome: 'SUCCESS',
    });
    return { items: result.rows, page: index };
  }
}
