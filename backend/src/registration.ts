/**
 * 화면·메뉴·RESP 등록 업무 로직. 목록 조회, 체크 행 일괄 처리, 메뉴 구성, RESP 시작 메뉴 연결을 담당한다.
 * 변경은 권한 재검사·버전 비교 후 한 트랜잭션으로 처리하며 한 행 실패 시 전체 롤백한다.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  SetMetadata,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { Db } from './db';
import { Audit } from './audit';
import { AppRequest, Permission } from './security';
export const registerCodes: Record<string, string> = {
  screens: 'SCREEN_REGISTER',
  menus: 'MENU_REGISTER',
  responsibilities: 'RESP_REGISTER',
};
const A = ['RESET', 'QUERY', 'SAVE', 'DELETE', 'ETC1', 'ETC2', 'ETC3', 'ETC4'];
const L = ['초기화', '조회', '저장', '삭제', '기타1', '기타2', '기타3', '기타4'];
const RegisterPermission = (action: string) => SetMetadata('registerPermission', action);
// 테이블명은 바인딩할 수 없으므로 허용 목록의 종류만 동적 SQL에 사용한다.
function kind(k: string) {
  if (!Object.hasOwn(registerCodes, k)) throw new NotFoundException('등록 화면이 없습니다.');
  return k;
}
// bigint ID는 문자열로 검증해 숫자 변환 시 정밀도 손실을 피한다.
function ident(v: any) {
  if (typeof v !== 'string' || !/^\d{1,18}$/.test(v))
    throw new BadRequestException('저장된 대상을 선택해주세요.');
  return v;
}
// 클라이언트가 조회한 버전이 최신 버전과 다르면 덮어쓰기 대신 충돌을 반환한다.
function version(v: any) {
  if (!Number.isInteger(v) || v < 1) throw new BadRequestException('버전이 올바르지 않습니다.');
  return v;
}
function text(v: any, max = 120) {
  if (typeof v !== 'string' || !v.trim() || v.length > max)
    throw new BadRequestException('필수 입력값과 길이를 확인해주세요.');
  return v.trim();
}
// 8개 동작의 불리언 값을 빠짐없이 받아 누락된 권한을 암묵적으로 허용하지 않는다.
function flags(v: any) {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).length !== 8 ||
    A.some((a) => typeof v[a] !== 'boolean')
  )
    throw new BadRequestException('8개 버튼 설정을 확인해주세요.');
  return v;
}
// DB 제약 위반을 사용자용 설명으로 바꾸고 원본 SQL 오류는 숨긴다.
function message(e: any) {
  if (e instanceof HttpException) return e.message;
  if (e.code === '23505') return '동일 코드 또는 연결이 이미 존재합니다.';
  if (e.code === '23503') return '다른 데이터에서 참조 중이므로 삭제할 수 없습니다.';
  if (e.code === '23514')
    return '순환 연결, 저장된 코드 변경 또는 배정된 RESP의 접근 구분 변경은 허용하지 않습니다.';
  return '처리 중 오류가 발생했습니다.';
}
@Injectable()
export class RegistrationService {
  constructor(
    private readonly db: Db,
    private readonly audit: Audit,
  ) {}
  // 메뉴 변경과 같은 자문 잠금을 잡은 뒤 DB 권한을 재검사한다. 요청 시작 후 권한이 바뀌었으면 쓰기를 거절한다.
  async lock(c: PoolClient, req: AppRequest, screen: string, action: string) {
    await c.query('SELECT pg_advisory_xact_lock(720260910)');
    const { rows } = await c.query(
      `WITH RECURSIVE reachable(id) AS (
   SELECT m.id FROM app.users u JOIN app.responsibilities r ON r.id=u.resp_id AND r.is_active JOIN app.menus m ON m.id=r.root_menu_id AND m.is_active WHERE u.id=$1 AND u.is_active AND r.authority_type='SYSTEM' AND EXISTS(SELECT 1 FROM app.account_access a WHERE a.id=u.id AND a.account_enabled AND a.mapping_ready)
   UNION SELECT e.child_menu_id FROM app.menu_edges e JOIN reachable p ON p.id=e.parent_menu_id JOIN app.menus m ON m.id=e.child_menu_id AND m.is_active)
   SELECT 1 FROM reachable r JOIN app.menu_screens ms ON ms.menu_id=r.id JOIN app.screens s ON s.id=ms.screen_id AND s.is_active AND s.code=$3
   JOIN app.screen_buttons b ON b.screen_id=s.id AND b.action_code=$4 AND b.is_used
   JOIN app.menu_screen_buttons mb ON mb.menu_screen_id=ms.id AND mb.action_code=b.action_code AND mb.is_allowed WHERE r.id=$2`,
      [req.actor!.id, req.get('x-menu-id'), screen, action],
    );
    if (!rows.length) throw new ForbiddenException('현재 저장·삭제 권한이 없습니다.');
    await c.query("SELECT set_config('app.actor_name',$1,true)", [req.actor!.display_name]);
  }
  // 기본 행과 버튼을 묶어 감사 스냅샷을 만든다. k는 호출 전에 허용 목록 검증을 거쳐야 한다.
  async row(c: PoolClient, k: string, id: string) {
    const r = (await c.query('SELECT * FROM app.' + k + ' WHERE id=$1', [id])).rows[0];
    if (r && k === 'screens')
      r.buttons = Object.fromEntries(
        (
          await c.query('SELECT action_code,is_used FROM app.screen_buttons WHERE screen_id=$1', [
            id,
          ])
        ).rows.map((b) => [b.action_code, b.is_used]),
      );
    return r;
  }
  // 같은 연결로 이벤트와 변경 전후 값을 기록하여 업무 롤백 시 성공 기록도 취소한다.
  async log(
    c: PoolClient,
    req: AppRequest,
    k: string,
    id: string,
    before: any,
    after: any,
    action: string,
  ) {
    const event = await this.audit.write(
      {
        requestId: req.requestId,
        userId: req.actor!.id,
        respId: req.actor!.resp_id,
        menuId: req.get('x-menu-id'),
        action,
        outcome: 'SUCCESS',
      },
      c,
    );
    await c.query(
      'INSERT INTO audit.audit_changes(event_id,entity_type,entity_key,change_type,before_values,after_values) VALUES($1,$2,$3,$4,$5,$6)',
      [event, k, id, !after ? 'DELETE' : !before ? 'INSERT' : 'UPDATE', before, after],
    );
  }
  // 2001행을 읽어 2000행 초과를 감지하고 조회 조건을 좁히도록 안내한다.
  async list(k: string, code = '', name = '') {
    kind(k);
    return this.db.tx(async (c) => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const rows = (
        await c.query(
          'SELECT t.*, ' +
            (k === 'responsibilities'
              ? 'm.code AS menu_code,m.name AS menu_name'
              : 'NULL AS menu_code,NULL AS menu_name') +
            ' FROM app.' +
            k +
            ' t ' +
            (k === 'responsibilities' ? 'LEFT JOIN app.menus m ON m.id=t.root_menu_id ' : '') +
            'WHERE strpos(lower(t.code),lower($1))>0 AND strpos(lower(t.name),lower($2))>0 ORDER BY t.id LIMIT 2001',
          [String(code).slice(0, 120), String(name).slice(0, 120)],
        )
      ).rows;
      if (rows.length > 2000)
        throw new BadRequestException('조회조건을 좁혀주세요. 최대 2000행입니다.');
      if (k === 'screens') {
        const b = (
          await c.query(
            'SELECT screen_id,action_code,is_used FROM app.screen_buttons WHERE screen_id=ANY($1::bigint[])',
            [rows.map((r) => r.id)],
          )
        ).rows;
        rows.forEach(
          (r) =>
            (r.buttons = Object.fromEntries(
              A.map((a) => [
                a,
                b.find((v) => v.screen_id === r.id && v.action_code === a)?.is_used || false,
              ]),
            )),
        );
      }
      return { items: rows };
    });
  }
  // 최대 500개의 체크 행을 순서대로 처리한다. 중간 오류가 나면 앞서 처리한 행도 함께 롤백한다.
  async batch(req: AppRequest, k: string, body: any, remove = false) {
    kind(k);
    if (
      !body ||
      !Array.isArray(body.rows) ||
      !body.rows.length ||
      body.rows.length > 500 ||
      Object.keys(body).some((x) => x !== 'rows')
    )
      throw new BadRequestException('1~500개의 체크 행을 선택해주세요.');
    return this.db.tx(async (c) => {
      await this.lock(c, req, registerCodes[k], remove ? 'DELETE' : 'SAVE');
      const results = [],
        seen = new Set<string>();
      for (let index = 0; index < body.rows.length; index++) {
        const r = body.rows[index];
        try {
          if (!r || typeof r !== 'object' || Array.isArray(r))
            throw new BadRequestException('행 입력 형식이 잘못되었습니다.');
          const allowed = remove
            ? ['id', 'version', 'clientKey', 'rowNumber']
            : [
                'id',
                'version',
                'clientKey',
                'rowNumber',
                'code',
                'name',
                ...(k === 'screens' ? ['component_key', 'buttons'] : []),
                ...(k === 'responsibilities' ? ['authority_type', 'level'] : []),
              ];
          if (Object.keys(r).some((x) => !allowed.includes(x)))
            throw new BadRequestException('허용되지 않은 행 필드입니다.');
          const key = r.id === undefined ? undefined : ident(r.id);
          if (key && seen.has(key)) throw new BadRequestException('동일 행이 중복 포함되었습니다.');
          if (key) seen.add(key);
          const before = key ? await this.row(c, k, key) : null;
          if (key && (!before || before.version !== version(r.version)))
            throw new ConflictException(
              '다른 작업에서 변경 또는 삭제되었습니다. 다시 조회해주세요.',
            );
          let savedId = key;
          if (remove) {
            if (!key) throw new BadRequestException('신규 행은 행삭제 버튼으로 제거해주세요.');
            if (
              k === 'responsibilities' &&
              (await c.query('SELECT 1 FROM app.users WHERE resp_id=$1 LIMIT 1', [key])).rowCount
            )
              throw new ConflictException(
                '사용자에게 부여된 RESP입니다. 사용자 RESP를 먼저 변경해주세요.',
              );
            if (k === 'screens')
              await c.query('DELETE FROM app.screen_buttons WHERE screen_id=$1', [key]);
            await c.query('DELETE FROM app.' + k + ' WHERE id=$1', [key]);
          } else {
            const code = text(r.code),
              name = text(r.name);
            if (!/^[A-Za-z0-9_.-]+$/.test(code))
              throw new BadRequestException('코드에는 영문·숫자·밑줄·점·하이픈만 입력해주세요.');
            if (before && before.code !== code)
              throw new BadRequestException('저장된 코드는 수정할 수 없습니다.');
            const fields = ['code', 'name'],
              values: any[] = [code, name];
            if (k === 'screens') {
              fields.push('component_key');
              values.push(text(r.component_key));
              flags(r.buttons);
            }
            if (k === 'responsibilities') {
              const authority = r.authority_type ?? before?.authority_type ?? 'CUSTOMER';
              if (!['SYSTEM', 'CUSTOMER'].includes(authority))
                throw new BadRequestException('접근 구분은 SYSTEM 또는 CUSTOMER입니다.');
              // 0이 최상위이며 동급도 허용한다. 현재 권한 검사에는 사용하지 않는다.
              const level = r.level ?? before?.level ?? 100;
              if (!Number.isInteger(level) || level < 0 || level > 9999)
                throw new BadRequestException('RESP 레벨은 0~9999 정수입니다.');
              fields.push('authority_type', 'level');
              values.push(authority, level);
            }
            const sql = key
              ? 'UPDATE app.' +
                k +
                ' SET ' +
                fields.map((f, i) => f + '=$' + (i + 1)).join(',') +
                ' WHERE id=$' +
                (values.length + 1) +
                ' RETURNING id'
              : 'INSERT INTO app.' +
                k +
                '(' +
                fields.join(',') +
                ') VALUES(' +
                values.map((_, i) => '$' + (i + 1)).join(',') +
                ') RETURNING id';
            savedId = (await c.query(sql, key ? [...values, key] : values)).rows[0].id;
            if (k === 'screens')
              for (const [i, a] of A.entries())
                await c.query(
                  'INSERT INTO app.screen_buttons(screen_id,action_code,label,is_used) VALUES($1,$2,$3,$4) ON CONFLICT(screen_id,action_code) DO UPDATE SET is_used=EXCLUDED.is_used',
                  [savedId, a, L[i], r.buttons[a]],
                );
          }
          const after = remove ? null : await this.row(c, k, savedId!);
          await this.log(
            c,
            req,
            k,
            savedId!,
            before,
            after,
            'REGISTER_' + (remove ? 'DELETE' : key ? 'UPDATE' : 'INSERT'),
          );
          results.push({ clientKey: r.clientKey, item: after, id: savedId });
        } catch (e: any) {
          throw new HttpException(
            {
              message: '행 처리에 실패하여 전체 작업을 취소했습니다.',
              rowErrors: [
                {
                  clientKey:
                    typeof r?.clientKey === 'string' ? r.clientKey.slice(0, 100) : undefined,
                  rowNumber: Number.isInteger(r?.rowNumber) ? r.rowNumber : index + 1,
                  code: typeof r?.code === 'string' ? r.code.slice(0, 120) : undefined,
                  message: message(e),
                },
              ],
            },
            e instanceof HttpException ? e.getStatus() : e.code?.startsWith('23') ? 409 : 500,
          );
        }
      }
      return { items: results };
    });
  }
  // 하위 메뉴(M)와 화면(F)을 표시 순서로 합친다. 버튼 사용 여부와 연결 권한은 별도로 반환한다.
  async layout(c: PoolClient, parent: string) {
    const rows = (
      await c.query(
        `SELECT 'M' AS kind,e.child_menu_id AS target_id,m.code,m.name,e.hidden,e.sort_order,e.created_by,e.created_at
    FROM app.menu_edges e JOIN app.menus m ON m.id=e.child_menu_id WHERE e.parent_menu_id=$1
    UNION ALL SELECT 'F',s.id,s.code,s.name,ms.hidden,ms.sort_order,ms.created_by,ms.created_at
    FROM app.menu_screens ms JOIN app.screens s ON s.id=ms.screen_id WHERE ms.menu_id=$1 ORDER BY sort_order,kind,target_id`,
        [parent],
      )
    ).rows;
    const b = (
      await c.query(
        'SELECT ms.screen_id,sb.action_code,sb.is_used,COALESCE(mb.is_allowed,false) AS allowed FROM app.menu_screens ms JOIN app.screen_buttons sb ON sb.screen_id=ms.screen_id LEFT JOIN app.menu_screen_buttons mb ON mb.menu_screen_id=ms.id AND mb.action_code=sb.action_code WHERE ms.menu_id=$1',
        [parent],
      )
    ).rows;
    return rows.map((r) => ({
      ...r,
      buttons: Object.fromEntries(
        A.map((a) => [
          a,
          b.find((v) => v.screen_id === r.target_id && v.action_code === a)?.allowed || false,
        ]),
      ),
      usage: Object.fromEntries(
        A.map((a) => [
          a,
          b.find((v) => v.screen_id === r.target_id && v.action_code === a)?.is_used || false,
        ]),
      ),
    }));
  }
  // 부모·현재 연결·후보 목록을 반환한다. 후보는 부모 구성 트랜잭션과 별도로 조회한 결과다.
  async menuDetail(id: string) {
    ident(id);
    const [menus, screens] = await Promise.all([this.list('menus'), this.list('screens')]);
    return this.db.tx(async (c) => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const parent = await this.row(c, 'menus', id);
      if (!parent) throw new NotFoundException('메뉴가 없습니다.');
      return { parent, rows: await this.layout(c, id), menus: menus.items, screens: screens.items };
    });
  }
  // 전달된 배열이 이 부모의 최종 구성이다. 빠진 연결을 제거하고 배열 순서로 정렬값을 저장한다.
  async applyMenu(req: AppRequest, id: string, body: any) {
    ident(id);
    version(body?.version);
    if (
      !Array.isArray(body?.rows) ||
      body.rows.length > 500 ||
      Object.keys(body).some((k) => !['version', 'rows'].includes(k))
    )
      throw new BadRequestException('매핑 입력을 확인해주세요.');
    return this.db.tx(async (c) => {
      await this.lock(c, req, 'MENU_REGISTER', 'SAVE');
      const parent = await this.row(c, 'menus', id);
      if (!parent || parent.version !== body.version)
        throw new ConflictException('메뉴가 변경되었습니다. 다시 선택해주세요.');
      const before = await this.layout(c, id),
        keys = new Set<string>();
      // Validate first, then change only this parent's links.
      for (const [i, r] of body.rows.entries()) {
        try {
          if (
            !r ||
            !['M', 'F'].includes(r.kind) ||
            typeof r.hidden !== 'boolean' ||
            Object.keys(r).some((k) => !['kind', 'target_id', 'hidden', 'buttons'].includes(k))
          )
            throw new BadRequestException('연결 형식을 확인해주세요.');
          ident(r.target_id);
          const key = r.kind + ':' + r.target_id;
          if (keys.has(key)) throw new BadRequestException('중복 연결입니다.');
          keys.add(key);
          if (r.kind === 'F') flags(r.buttons);
        } catch (e) {
          throw new BadRequestException({
            message: '메뉴 적용을 취소했습니다.',
            rowErrors: [{ rowNumber: i + 1, message: message(e) }],
          });
        }
      }
      for (const old of before) {
        if (keys.has(old.kind + ':' + old.target_id)) continue;
        if (old.kind === 'M')
          await c.query('SELECT app.set_menu_edge($1,$2,0,true)', [id, old.target_id]);
        else {
          await c.query(
            'DELETE FROM app.menu_screen_buttons WHERE menu_screen_id IN(SELECT id FROM app.menu_screens WHERE menu_id=$1 AND screen_id=$2)',
            [id, old.target_id],
          );
          await c.query('DELETE FROM app.menu_screens WHERE menu_id=$1 AND screen_id=$2', [
            id,
            old.target_id,
          ]);
        }
      }
      for (const [i, r] of body.rows.entries()) {
        try {
          if (r.kind === 'M')
            await c.query('SELECT app.set_menu_edge($1,$2,$3,false,$4)', [
              id,
              r.target_id,
              i,
              r.hidden,
            ]);
          else {
            const map = (
              await c.query(
                'INSERT INTO app.menu_screens(menu_id,screen_id,sort_order,hidden) VALUES($1,$2,$3,$4) ON CONFLICT(menu_id,screen_id) DO UPDATE SET sort_order=EXCLUDED.sort_order,hidden=EXCLUDED.hidden RETURNING id',
                [id, r.target_id, i, r.hidden],
              )
            ).rows[0].id;
            const used = (
              await c.query(
                'SELECT action_code,is_used FROM app.screen_buttons WHERE screen_id=$1',
                [r.target_id],
              )
            ).rows;
            for (const a of A)
              await c.query(
                'INSERT INTO app.menu_screen_buttons(menu_screen_id,action_code,is_allowed) VALUES($1,$2,$3) ON CONFLICT(menu_screen_id,action_code) DO UPDATE SET is_allowed=EXCLUDED.is_allowed',
                [map, a, r.buttons[a] && Boolean(used.find((b) => b.action_code === a)?.is_used)],
              );
          }
        } catch (e) {
          throw new ConflictException({
            message: '메뉴 적용을 취소했습니다.',
            rowErrors: [{ rowNumber: i + 1, message: message(e) }],
          });
        }
      }
      // 연결만 바뀌어도 부모 버전 트리거를 실행하여 오래된 구성 저장을 충돌로 감지한다.
      await c.query('UPDATE app.menus SET name=name WHERE id=$1', [id]);
      const after = await this.layout(c, id);
      await this.log(
        c,
        req,
        'menus',
        id,
        { parent, rows: before },
        { parent: await this.row(c, 'menus', id), rows: after },
        'MENU_APPLY',
      );
      return { parent: await this.row(c, 'menus', id), rows: after };
    });
  }
  // RESP의 현재 시작 메뉴와 연결 후보 목록을 조회한다.
  async respDetail(id: string) {
    const rows = (
      await this.db.pool.query(
        'SELECT r.*,m.code AS menu_code,m.name AS menu_name FROM app.responsibilities r LEFT JOIN app.menus m ON m.id=r.root_menu_id WHERE r.id=$1',
        [ident(id)],
      )
    ).rows;
    if (!rows[0]) throw new NotFoundException('RESP가 없습니다.');
    return { parent: rows[0], menus: (await this.list('menus')).items };
  }
  // 버전과 메뉴 존재를 확인한 뒤 시작 메뉴를 교체하고 변경 전후를 기록한다.
  async applyResp(req: AppRequest, id: string, body: any) {
    ident(id);
    ident(body?.menuId);
    version(body?.version);
    if (Object.keys(body).some((k) => !['menuId', 'version'].includes(k)))
      throw new BadRequestException('적용 입력을 확인해주세요.');
    return this.db.tx(async (c) => {
      await this.lock(c, req, 'RESP_REGISTER', 'SAVE');
      const before = await this.row(c, 'responsibilities', id);
      if (!before || before.version !== body.version)
        throw new ConflictException('RESP가 변경되었습니다. 다시 선택해주세요.');
      if (!(await c.query('SELECT 1 FROM app.menus WHERE id=$1', [body.menuId])).rowCount)
        throw new BadRequestException('메뉴가 없습니다.');
      await c.query('UPDATE app.responsibilities SET root_menu_id=$2 WHERE id=$1', [
        id,
        body.menuId,
      ]);
      const after = await this.row(c, 'responsibilities', id);
      await this.log(c, req, 'responsibilities', id, before, after, 'RESP_APPLY');
      return { parent: after };
    });
  }
}
@Controller('api/registration')
export class RegistrationController {
  constructor(
    private readonly service: RegistrationService,
    private readonly audit: Audit,
  ) {}
  @Get(':kind')
  @RegisterPermission('QUERY')
  async list(
    @Req() req: AppRequest,
    @Param('kind') k: string,
    @Query('code') code = '',
    @Query('name') name = '',
  ) {
    const result = await this.service.list(k, code, name);
    await this.audit.write({
      requestId: req.requestId,
      userId: req.actor!.id,
      action: 'REGISTER_QUERY',
      outcome: 'SUCCESS',
    });
    return result;
  }
  @Post(':kind/save')
  @RegisterPermission('SAVE')
  save(@Req() req: AppRequest, @Param('kind') k: string, @Body() body: any) {
    return this.service.batch(req, k, body);
  }
  @Post(':kind/delete')
  @RegisterPermission('DELETE')
  remove(@Req() req: AppRequest, @Param('kind') k: string, @Body() body: any) {
    return this.service.batch(req, k, body, true);
  }
  @Get('menus/:id/layout')
  @Permission('MENU_REGISTER', 'QUERY')
  async layout(@Req() req: AppRequest, @Param('id') id: string) {
    const r = await this.service.menuDetail(id);
    await this.audit.write({
      requestId: req.requestId,
      userId: req.actor!.id,
      action: 'MENU_LAYOUT_QUERY',
      outcome: 'SUCCESS',
    });
    return r;
  }
  @Post('menus/:id/apply')
  @Permission('MENU_REGISTER', 'SAVE')
  applyMenu(@Req() req: AppRequest, @Param('id') id: string, @Body() body: any) {
    return this.service.applyMenu(req, id, body);
  }
  @Get('responsibilities/:id/link')
  @Permission('RESP_REGISTER', 'QUERY')
  async link(@Req() req: AppRequest, @Param('id') id: string) {
    const r = await this.service.respDetail(id);
    await this.audit.write({
      requestId: req.requestId,
      userId: req.actor!.id,
      action: 'RESP_LINK_QUERY',
      outcome: 'SUCCESS',
    });
    return r;
  }
  @Post('responsibilities/:id/apply')
  @Permission('RESP_REGISTER', 'SAVE')
  applyResp(@Req() req: AppRequest, @Param('id') id: string, @Body() body: any) {
    return this.service.applyResp(req, id, body);
  }
}
