/**
 * 고객사 코드 준비, 공개 가입, 관리자 직접 등록·승인을 담당한다.
 * RESP 기능 권한과 고객사 관리 범위를 함께 검사하며 모든 변경은 같은 잠금·트랜잭션을 사용한다.
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
  Req,
  SetMetadata,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import * as argon2 from 'argon2';
import { Db, useWorkspace } from './db';
import { Recovery, emailAddress } from './recovery';
import { Audit } from './audit';
import { AppRequest, Permission, Public } from './security';

const catalogCodes: Record<string, string> = {
  customers: 'CUSTOMER_REGISTER',
  corporations: 'CORPORATION_REGISTER',
  departments: 'DEPARTMENT_REGISTER',
};
const CatalogPermission = (action: string) => SetMetadata('catalogPermission', action);
const id = (v: unknown) => {
  if (typeof v !== 'string' || !/^\d{1,18}$/.test(v))
    throw new BadRequestException('선택값을 확인해주세요.');
  return v;
};
const text = (v: unknown, max: number, optional = false) => {
  if (typeof v !== 'string' || v.length > max || (!optional && !v.trim()))
    throw new BadRequestException('필수 입력과 길이를 확인해주세요.');
  return v.trim();
};
function fields(body: any, allowed: string[]) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((k) => !allowed.includes(k))
  )
    throw new BadRequestException('허용되지 않은 입력입니다.');
}
@Injectable()
export class Accounts {
  constructor(
    private readonly db: Db,
    private readonly audit: Audit,
    private readonly recovery: Recovery,
  ) {}

  private async actor(c: PoolClient, req: AppRequest, action: string, screen = 'USER_REGISTER') {
    // 기존 설정 변경과 같은 잠금을 사용해 권한 검사와 쓰기 사이의 변경을 직렬화한다.
    await c.query('SELECT pg_advisory_xact_lock(720260910)');
    const actor = (
      await c.query(
        `SELECT u.*,a.authority_type FROM app.users u JOIN app.account_access a ON a.id=u.id WHERE u.id=$1 AND a.account_enabled AND a.mapping_ready`,
        [req.actor!.id],
      )
    ).rows[0];
    if (!actor || (screen === 'CUSTOMER_REGISTER' && actor.authority_type !== 'SYSTEM'))
      throw new ForbiddenException('운영자 권한이 필요합니다.');
    const allowed = await c.query(
      `WITH RECURSIVE reachable(id) AS (
      SELECT m.id FROM app.menus m WHERE m.id=(SELECT root_menu_id FROM app.responsibilities WHERE id=$1) AND m.is_active
      UNION SELECT e.child_menu_id FROM app.menu_edges e JOIN reachable p ON p.id=e.parent_menu_id JOIN app.menus m ON m.id=e.child_menu_id AND m.is_active)
      SELECT 1 FROM reachable p JOIN app.menu_screens ms ON ms.menu_id=p.id JOIN app.screens s ON s.id=ms.screen_id AND s.is_active
      JOIN app.screen_buttons b ON b.screen_id=s.id AND b.action_code=$4 AND b.is_used
      JOIN app.menu_screen_buttons mb ON mb.menu_screen_id=ms.id AND mb.action_code=b.action_code AND mb.is_allowed
      WHERE p.id=$2 AND s.code=$3`,
      [actor.resp_id, req.get('x-menu-id'), screen, action],
    );
    if (!allowed.rowCount) throw new ForbiddenException('현재 작업 권한이 없습니다.');
    return actor;
  }
  private async customer(c: PoolClient, customerId: string) {
    const t = (
      await c.query('SELECT id,code,name FROM app.customers WHERE id=$1 AND is_active', [
        id(customerId),
      ])
    ).rows[0];
    if (!t) throw new NotFoundException('사용 가능한 고객사가 없습니다.');
    return t;
  }
  // 관리 화면은 자기 고객사 전체가 대상이다. 개인 업무 매핑과 혼동하지 않는다.
  private tenant(actor: any, customerId: string | null) {
    if (actor.authority_type !== 'SYSTEM' && (!customerId || actor.customer_id !== customerId))
      throw new ForbiddenException('고객사 접근 권한이 없습니다.');
  }
  private async resp(c: PoolClient, respId: string, systemAllowed = false) {
    const r = (
      await c.query(
        'SELECT id,authority_type FROM app.responsibilities WHERE id=$1 AND is_active',
        [id(respId)],
      )
    ).rows[0];
    if (!r || (!systemAllowed && r.authority_type === 'SYSTEM'))
      throw new BadRequestException('허용된 RESP를 선택해주세요.');
    return r;
  }
  private async log(
    c: PoolClient,
    req: AppRequest,
    kind: string,
    key: string,
    before: any,
    after: any,
  ) {
    const event = await this.audit.write(
      {
        requestId: req.requestId,
        userId: req.actor!.id,
        action: kind.toUpperCase() + '_SAVE',
        outcome: 'SUCCESS',
      },
      c,
    );
    await c.query(
      'INSERT INTO audit.audit_changes(event_id,entity_type,entity_key,change_type,before_values,after_values) VALUES($1,$2,$3,$4,$5,$6)',
      [event, kind, key, !after ? 'DELETE' : !before ? 'INSERT' : 'UPDATE', before, after],
    );
  }
  private async change<T>(fn: (c: PoolClient) => Promise<T>) {
    try {
      return await this.db.tx(fn);
    } catch (e: any) {
      if (e instanceof HttpException) throw e;
      if (e.code === '23505') throw new ConflictException('이미 사용 중인 아이디 또는 코드입니다.');
      if (e.code?.startsWith('23'))
        throw new BadRequestException('연결된 데이터와 입력값을 확인해주세요.');
      throw e;
    }
  }
  /** 상위 그리드 후보도 서버에서 고객사로 제한한다. */
  async catalogs(req: AppRequest, kind: string) {
    if (!Object.hasOwn(catalogCodes, kind)) throw new NotFoundException('등록 화면이 없습니다.');
    return this.db.tx(async (c) => {
      const actor = await this.actor(c, req, 'QUERY', catalogCodes[kind]);
      const args = [actor.authority_type === 'SYSTEM', actor.customer_id];
      return {
        customers: (
          await c.query('SELECT * FROM app.customers WHERE ($1 OR id=$2) ORDER BY code', args)
        ).rows,
        corporations:
          kind === 'customers'
            ? []
            : (
                await c.query(
                  'SELECT * FROM app.corporations WHERE ($1 OR customer_id=$2) ORDER BY code',
                  args,
                )
              ).rows,
        departments:
          kind !== 'departments'
            ? []
            : (
                await c.query(
                  'SELECT * FROM app.departments WHERE ($1 OR customer_id=$2) ORDER BY code',
                  args,
                )
              ).rows,
      };
    });
  }
  /** 선택 행 전체를 함께 저장/삭제한다. 부모 이동과 저장된 코드 변경은 허용하지 않는다. */
  async saveCatalog(req: AppRequest, kind: string, body: any, remove = false) {
    if (!Object.hasOwn(catalogCodes, kind)) throw new NotFoundException('등록 화면이 없습니다.');
    fields(body, ['customerId', 'corporationId', 'rows']);
    if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > 500)
      throw new BadRequestException('1~500개 행을 선택해주세요.');
    return this.change(async (c) => {
      const actor = await this.actor(c, req, remove ? 'DELETE' : 'SAVE', catalogCodes[kind]);
      if (kind !== 'customers') {
        await this.customer(c, body.customerId);
        this.tenant(actor, body.customerId);
      }
      if (
        kind === 'departments' &&
        !(
          await c.query('SELECT 1 FROM app.corporations WHERE id=$1 AND customer_id=$2', [
            id(body.corporationId),
            body.customerId,
          ])
        ).rowCount
      )
        throw new BadRequestException('해당 고객사의 법인을 선택해주세요.');
      const items = [],
        seen = new Set();
      for (const r of body.rows) {
        fields(r, ['id', 'version', 'clientKey', 'code', 'name']);
        if (r.id && seen.has(r.id)) throw new BadRequestException('중복 행입니다.');
        seen.add(r.id);
        const before = r.id
          ? (await c.query('SELECT * FROM app.' + kind + ' WHERE id=$1 FOR UPDATE', [id(r.id)]))
              .rows[0]
          : null;
        if (r.id && (!before || before.version !== r.version))
          throw new ConflictException('다른 작업에서 변경했습니다. 다시 조회해주세요.');
        if (
          before &&
          kind !== 'customers' &&
          (before.customer_id !== body.customerId ||
            (kind === 'departments' && before.corporation_id !== body.corporationId))
        )
          throw new ForbiddenException('선택한 상위 코드와 다른 행입니다.');
        let after = null;
        if (remove) {
          if (!before) throw new BadRequestException('신규 행은 행삭제로 제거해주세요.');
          await c.query('DELETE FROM app.' + kind + ' WHERE id=$1', [r.id]);
        } else {
          const code = text(r.code, 40),
            name = text(r.name, 120);
          if (!/^[A-Za-z0-9_-]+$/.test(code))
            throw new BadRequestException('코드는 영문·숫자·밑줄·하이픈으로 입력해주세요.');
          if (before && before.code !== code)
            throw new BadRequestException('저장된 코드는 변경할 수 없습니다.');
          const columns = ['code', 'name'],
            values: any[] = [code, name];
          if (!before && kind !== 'customers') {
            columns.push('customer_id');
            values.push(body.customerId);
          }
          if (!before && kind === 'departments') {
            columns.push('corporation_id');
            values.push(body.corporationId);
          }
          after = (
            await c.query(
              before
                ? 'UPDATE app.' + kind + ' SET name=$2 WHERE id=$1 RETURNING *'
                : 'INSERT INTO app.' +
                    kind +
                    '(' +
                    columns.join(',') +
                    ') VALUES(' +
                    values.map((_, i) => '$' + (i + 1)).join(',') +
                    ') RETURNING *',
              before ? [r.id, name] : values,
            )
          ).rows[0];
        }
        await this.log(c, req, kind, before?.id || after.id, before, after);
        items.push({ clientKey: r.clientKey, item: after });
      }
      return { items };
    });
  }
  async options(req: AppRequest) {
    return this.db.tx(async (c) => {
      const actor = await this.actor(c, req, 'QUERY');
      const customers = (
        await c.query(
          'SELECT id,code,name FROM app.customers WHERE is_active AND ($1 OR id=$2) ORDER BY code',
          [actor.authority_type === 'SYSTEM', actor.customer_id],
        )
      ).rows;
      for (const t of customers) Object.assign(t, await this.selection(c, t.id));
      const responsibilities = (
        await c.query(
          "SELECT id,code,name,authority_type,level FROM app.responsibilities WHERE is_active AND ($1 OR authority_type='CUSTOMER') ORDER BY code",
          [actor.authority_type === 'SYSTEM'],
        )
      ).rows;
      return { operator: actor.authority_type === 'SYSTEM', customers, responsibilities };
    });
  }
  private async selection(c: PoolClient, customerId: string) {
    return {
      corporations: (
        await c.query(
          'SELECT id,code,name FROM app.corporations WHERE customer_id=$1 ORDER BY code',
          [customerId],
        )
      ).rows,
      departments: (
        await c.query(
          'SELECT id,corporation_id,code,name FROM app.departments WHERE customer_id=$1 ORDER BY code',
          [customerId],
        )
      ).rows,
    };
  }
  /**
   * 가입 링크 토큰으로 워크스페이스·고객사를 찾고, 이 공개 요청의 DB 범위를 그 워크스페이스로 지정한다.
   * 토큰은 추측할 수 없는 무작위 값이며 고객사 코드는 링크에 쓰지 않는다. 비활성 고객사·정지 업체는 거절한다.
   */
  private async signupTarget(token: string) {
    const t = /^[a-f0-9]{64}$/.test(token)
      ? (await this.db.query('SELECT * FROM app.signup_target($1)', [token])).rows[0]
      : undefined;
    if (!t) throw new NotFoundException('유효한 고객사 가입 링크가 아닙니다.');
    useWorkspace(t.workspace_id);
    return String(t.customer_id);
  }
  async publicOptions(token: string) {
    await this.signupTarget(token);
    return { ok: true };
  }
  async create(req: AppRequest, body: any, signupToken?: string) {
    fields(
      body,
      signupToken
        ? ['loginId', 'name', 'address', 'mobile', 'email', 'password']
        : ['customerId', 'loginId', 'name', 'address', 'mobile', 'email', 'respId'],
    );
    const loginId = text(body.loginId, 80),
      name = text(body.name, 120),
      address = text(body.address, 500, true),
      mobile = text(body.mobile, 30),
      email = emailAddress(body.email);
    if (
      !/^[A-Za-z0-9_.-]+$/.test(loginId) ||
      !/^[+0-9() -]{7,30}$/.test(mobile) ||
      (signupToken &&
        (typeof body.password !== 'string' ||
          body.password.length < 15 ||
          body.password.length > 128))
    )
      throw new BadRequestException('아이디·휴대전화·비밀번호(15~128자)를 확인해주세요.');
    if (signupToken) {
      // 공개 가입의 비싼 비밀번호 해시 계산 전에 IP별 요청 수를 제한한다.
      const bucket =
        'signup:' +
        createHash('sha256')
          .update(req.ip || '')
          .digest('hex');
      const limit = await this.db.query(
        `INSERT INTO app.login_limits VALUES($1,1,now()+interval '15 minutes') ON CONFLICT(bucket)
        DO UPDATE SET attempts=CASE WHEN app.login_limits.expires_at<=now() THEN 1 ELSE app.login_limits.attempts+1 END,
        expires_at=CASE WHEN app.login_limits.expires_at<=now() THEN now()+interval '15 minutes' ELSE app.login_limits.expires_at END RETURNING attempts`,
        [bucket],
      );
      if (limit.rows[0].attempts > 10)
        throw new HttpException('가입 요청이 많습니다. 잠시 후 다시 시도해주세요.', 429);
    }
    const signupCustomer = signupToken ? await this.signupTarget(signupToken) : null;
    const hash = signupToken ? await argon2.hash(body.password) : null;
    return this.change(async (c) => {
      let actor: any = null,
        customerId: string | null;
      if (signupToken) {
        await c.query('SELECT pg_advisory_xact_lock(720260910)');
        // 잠금 후 다시 확인해 링크 확인과 가입 사이에 고객사가 비활성화된 경우를 거절한다.
        const t = (
          await c.query('SELECT id FROM app.customers WHERE id=$1 AND is_active', [signupCustomer])
        ).rows[0];
        if (!t) throw new NotFoundException('유효한 고객사 가입 링크가 아닙니다.');
        customerId = t.id;
      } else {
        actor = await this.actor(c, req, 'SAVE');
        customerId = body.customerId ? (await this.customer(c, body.customerId)).id : null;
        this.tenant(actor, customerId);
      }
      const resp = actor
        ? await this.resp(c, body.respId, actor.authority_type === 'SYSTEM')
        : null;
      if (resp?.authority_type === 'CUSTOMER' && !customerId)
        throw new BadRequestException('고객사를 선택해주세요.');
      if (resp?.authority_type === 'SYSTEM' && customerId)
        throw new BadRequestException('SYSTEM 계정은 고객사를 지정하지 않습니다.');
      const user = (
        await c.query(
          `INSERT INTO app.users(login_id,password_hash,display_name,resp_id,is_active,must_change_password,customer_id,address,mobile,account_status,registration_source,reviewed_by,reviewed_at,email)
        VALUES($1,$2,$3,$4,$5,false,$6,$7,$8,$9,$10,$11,CASE WHEN $5 THEN now() ELSE NULL END,$12) RETURNING id,email,display_name`,
          [
            loginId,
            hash,
            name,
            resp?.id || null,
            Boolean(actor),
            customerId,
            address,
            mobile,
            actor ? 'ACTIVE' : 'PENDING',
            actor ? 'ADMIN' : 'SIGNUP',
            actor?.id || null,
            email,
          ],
        )
      ).rows[0];
      await this.audit.write(
        {
          requestId: req.requestId,
          userId: actor?.id || user.id,
          action: actor ? 'USER_CREATE' : 'SIGNUP_REQUEST',
          outcome: 'SUCCESS',
        },
        c,
      );
      await this.recovery.issue(c, user, actor ? 'PASSWORD' : 'VERIFY');
      return {
        message: actor
          ? '등록했습니다. 비밀번호 설정 메일은 발송 보류입니다. 비밀번호 설정과 CUSTOMER 매핑 후 로그인할 수 있습니다.'
          : '가입 신청을 접수했습니다. 이메일 인증 메일은 발송 보류입니다. 승인과 법인·부서 매핑 후 로그인할 수 있습니다.',
      };
    });
  }
  /** 기본정보·RESP·고객사 변경. 고객사를 옮기면 이전 매핑을 비워 다른 고객사 권한이 남지 않게 한다. */
  async update(req: AppRequest, body: any) {
    fields(body, [
      'userId',
      'version',
      'name',
      'mobile',
      'address',
      'email',
      'customerId',
      'respId',
    ]);
    return this.change(async (c) => {
      const actor = await this.actor(c, req, 'SAVE');
      const u = (
        await c.query(
          'SELECT u.*,r.authority_type FROM app.users u LEFT JOIN app.responsibilities r ON r.id=u.resp_id WHERE u.id=$1 FOR UPDATE OF u',
          [id(body.userId)],
        )
      ).rows[0];
      if (!u) throw new NotFoundException('사용자가 없습니다.');
      this.tenant(actor, u.customer_id);
      if (actor.authority_type !== 'SYSTEM' && u.authority_type === 'SYSTEM')
        throw new ForbiddenException('SYSTEM 계정은 변경할 수 없습니다.');
      if (u.version !== body.version)
        throw new ConflictException('다른 작업에서 변경했습니다. 다시 조회해주세요.');
      if (u.id === actor.id)
        throw new BadRequestException('자신의 계정은 다른 운영담당자에게 변경을 요청해주세요.');
      const customerId = body.customerId ? (await this.customer(c, body.customerId)).id : null;
      this.tenant(actor, customerId);
      const r = await this.resp(c, body.respId, actor.authority_type === 'SYSTEM');
      if ((r.authority_type === 'SYSTEM') !== !customerId)
        throw new BadRequestException('SYSTEM은 고객사 없음, CUSTOMER는 고객사를 선택해주세요.');
      // 승인 대기에서 SYSTEM으로 변경하면 공개 신청의 권한 제한이 우회되므로 금지한다.
      if (u.account_status === 'PENDING' && r.authority_type === 'SYSTEM')
        throw new BadRequestException('가입 신청에는 CUSTOMER RESP만 배정할 수 있습니다.');
      const name = text(body.name, 120),
        mobile = text(body.mobile, 30),
        address = text(body.address, 500, true),
        email = body.email === undefined ? u.email : emailAddress(body.email);
      if (!/^[+0-9() -]{7,30}$/.test(mobile))
        throw new BadRequestException('휴대전화번호를 확인해주세요.');
      if (u.customer_id !== customerId) {
        await c.query('DELETE FROM app.user_scopes WHERE user_id=$1', [u.id]);
        await c.query('DELETE FROM app.user_corporations WHERE user_id=$1', [u.id]);
      }
      await c.query(
        'UPDATE app.users SET display_name=$2,mobile=$3,address=$4,customer_id=$5,resp_id=$6,email=$7,updated_at=now() WHERE id=$1',
        [u.id, name, mobile, address, customerId, r.id, email],
      );
      await this.log(
        c,
        req,
        'users',
        u.id,
        { customerId: u.customer_id, respId: u.resp_id, email: u.email },
        { customerId, respId: r.id, email },
      );
      return { message: '기본정보를 저장했습니다.' };
    });
  }
  /** 관리자도 링크를 이메일로만 준비한다. 저장 권한·대상 고객사·버전을 다시 확인한다. */
  async resetPassword(req: AppRequest, body: any) {
    fields(body, ['userId', 'version']);
    return this.change(async (c) => {
      const actor = await this.actor(c, req, 'SAVE');
      const u = (
        await c.query(
          'SELECT u.*,r.authority_type FROM app.users u LEFT JOIN app.responsibilities r ON r.id=u.resp_id WHERE u.id=$1 FOR UPDATE OF u',
          [id(body.userId)],
        )
      ).rows[0];
      if (!u) throw new NotFoundException('사용자가 없습니다.');
      this.tenant(actor, u.customer_id);
      if (actor.authority_type !== 'SYSTEM' && u.authority_type === 'SYSTEM')
        throw new ForbiddenException('SYSTEM 계정은 변경할 수 없습니다.');
      if (u.version !== body.version) throw new ConflictException('다시 조회해주세요.');
      if (['REJECTED', 'SUSPENDED'].includes(u.account_status))
        throw new BadRequestException('반려·정지 계정은 재승인 후 처리해주세요.');
      await this.recovery.issue(c, u, 'PASSWORD');
      const event = await this.audit.write(
        {
          requestId: req.requestId,
          userId: actor.id,
          action: 'USER_PASSWORD_LINK',
          outcome: 'SUCCESS',
        },
        c,
      );
      await c.query(
        "INSERT INTO audit.audit_changes(event_id,entity_type,entity_key,change_type,after_values) VALUES($1,'users',$2,'UPDATE',$3)",
        [event, u.id, { action: 'PASSWORD_LINK_PREPARED' }],
      );
      return {
        message:
          '비밀번호 설정 메일을 발송 보류로 준비했습니다. 기존 비밀번호는 링크 사용 전까지 유지됩니다.',
      };
    });
  }
  async list(req: AppRequest, customerId: string) {
    return this.db.tx(async (c) => {
      const actor = await this.actor(c, req, 'QUERY');
      const key = customerId === 'system' ? null : (await this.customer(c, customerId)).id;
      this.tenant(actor, key);
      const rows = (
        await c.query(
          `SELECT u.id,u.login_id,u.display_name,u.address,u.mobile,u.customer_id,u.account_status,u.registration_source,u.resp_id,u.version,u.review_note,u.email,u.email_verified_at,(u.password_hash IS NOT NULL) AS password_set,
        a.authority_type,a.mapping_ready,r.code AS resp_code,r.level AS resp_level,
        COALESCE((SELECT jsonb_agg(uc.corporation_id::text) FROM app.user_corporations uc WHERE uc.user_id=u.id),'[]') AS corporation_ids,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('corporation_id',s.corporation_id::text,'department_id',s.department_id::text)) FROM app.user_scopes s WHERE s.user_id=u.id),'[]') AS scopes
        FROM app.users u JOIN app.account_access a ON a.id=u.id LEFT JOIN app.responsibilities r ON r.id=u.resp_id
        WHERE u.customer_id IS NOT DISTINCT FROM $1::bigint ORDER BY u.id DESC LIMIT 2001`,
          [key],
        )
      ).rows;
      if (rows.length > 2000) throw new BadRequestException('조회 대상이 2000명을 초과했습니다.');
      return { items: rows };
    });
  }
  /** 승인 뒤 법인/부서를 확정한다. 전체 스냅샷과 버전을 함께 받아 덮어쓰기 충돌을 막는다. */
  async mapping(req: AppRequest, body: any) {
    fields(body, ['userId', 'version', 'corporationIds', 'departmentIds']);
    return this.change(async (c) => {
      const actor = await this.actor(c, req, 'ETC4');
      const u = (
        await c.query(
          'SELECT u.*,r.authority_type FROM app.users u JOIN app.responsibilities r ON r.id=u.resp_id WHERE u.id=$1 FOR UPDATE OF u',
          [id(body.userId)],
        )
      ).rows[0];
      if (!u) throw new NotFoundException('사용자가 없습니다.');
      this.tenant(actor, u.customer_id);
      if (u.authority_type === 'SYSTEM')
        throw new BadRequestException('SYSTEM 계정은 매핑하지 않습니다.');
      if (u.account_status !== 'ACTIVE')
        throw new BadRequestException('승인 완료된 사용자를 선택해주세요.');
      if (u.version !== body.version)
        throw new ConflictException('다른 작업에서 변경했습니다. 다시 조회해주세요.');
      const ids = (v: any) => {
        if (!Array.isArray(v) || v.length > 500 || new Set(v).size !== v.length)
          throw new BadRequestException('중복 없는 0~500개 항목을 선택해주세요.');
        return v.map(id);
      };
      const corporations = ids(body.corporationIds),
        departments = ids(body.departmentIds);
      const co = (
        await c.query(
          'SELECT id FROM app.corporations WHERE customer_id=$1 AND id=ANY($2::bigint[])',
          [u.customer_id, corporations],
        )
      ).rows;
      const ds = (
        await c.query(
          'SELECT id,corporation_id FROM app.departments WHERE customer_id=$1 AND corporation_id=ANY($2::bigint[]) AND id=ANY($3::bigint[])',
          [u.customer_id, corporations, departments],
        )
      ).rows;
      if (co.length !== corporations.length || ds.length !== departments.length)
        throw new BadRequestException('고객사·법인·부서 조합을 확인해주세요.');
      const before = {
        corporations: (
          await c.query('SELECT corporation_id FROM app.user_corporations WHERE user_id=$1', [u.id])
        ).rows,
        departments: (
          await c.query('SELECT department_id FROM app.user_scopes WHERE user_id=$1', [u.id])
        ).rows,
      };
      await c.query('DELETE FROM app.user_scopes WHERE user_id=$1', [u.id]);
      await c.query('DELETE FROM app.user_corporations WHERE user_id=$1', [u.id]);
      for (const co of corporations)
        await c.query('INSERT INTO app.user_corporations VALUES($1,$2,$3)', [
          u.customer_id,
          u.id,
          co,
        ]);
      for (const d of ds)
        await c.query(
          'INSERT INTO app.user_scopes(customer_id,user_id,corporation_id,department_id) VALUES($1,$2,$3,$4)',
          [u.customer_id, u.id, d.corporation_id, d.id],
        );
      // 빈 매핑을 다시 저장할 때도 버전과 세션 무효화를 보장한다.
      await c.query('UPDATE app.users SET updated_at=now() WHERE id=$1', [u.id]);
      await c.query(
        'UPDATE app.auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',
        [u.id],
      );
      await this.log(c, req, 'user_scopes', u.id, before, { corporations, departments });
      return { ok: true };
    });
  }
  /** 실제 삭제: 세션/매핑만 함께 제거하고, 승인자 참조나 업무 이력이 있으면 정지를 안내한다. */
  async remove(req: AppRequest, body: any) {
    fields(body, ['rows']);
    if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > 100)
      throw new BadRequestException('1~100개 행을 선택해주세요.');
    return this.change(async (c) => {
      const actor = await this.actor(c, req, 'DELETE'),
        seen = new Set<string>();
      for (const row of body.rows) {
        fields(row, ['id', 'version']);
        const key = id(row.id);
        if (seen.has(key)) throw new BadRequestException('중복 행입니다.');
        seen.add(key);
        const u = (
          await c.query(
            'SELECT u.*,r.authority_type FROM app.users u LEFT JOIN app.responsibilities r ON r.id=u.resp_id WHERE u.id=$1 FOR UPDATE OF u',
            [key],
          )
        ).rows[0];
        if (!u) throw new ConflictException('이미 삭제된 사용자입니다. 다시 조회해주세요.');
        this.tenant(actor, u.customer_id);
        if (u.id === actor.id) throw new ForbiddenException('본인 계정은 삭제할 수 없습니다.');
        if (actor.authority_type !== 'SYSTEM' && u.authority_type === 'SYSTEM')
          throw new ForbiddenException('SYSTEM 계정은 삭제할 수 없습니다.');
        if (u.version !== row.version)
          throw new ConflictException('다른 작업에서 변경했습니다. 다시 조회해주세요.');
        // 감사 원본은 삭제하지 않는다. 단순 가입/인증/조회 이력은 계정 삭제를 막지 않으며 숫자 ID로 보존한다.
        const history = await c.query(
          `SELECT 1 FROM app.users WHERE reviewed_by=$1
          UNION ALL SELECT 1 FROM app.idempotency_records WHERE user_id=$1
          UNION ALL SELECT 1 FROM audit.event_summary WHERE user_id=$1 AND outcome='SUCCESS'
          AND action NOT IN ('SIGNUP_REQUEST','LOGIN','LOGOUT','PASSWORD_CHANGE','PASSWORD_RESET','EMAIL_VERIFY','SESSION_EXPIRED','NAVIGATION','USER_QUERY','AUDIT_QUERY','AUDIT_DETAIL') LIMIT 1`,
          [u.id],
        );
        if (history.rowCount)
          throw new ConflictException(
            '승인 또는 업무 처리 이력이 있는 계정은 삭제할 수 없습니다. 정지를 사용해주세요.',
          );
        await c.query('DELETE FROM app.user_scopes WHERE user_id=$1', [u.id]);
        await c.query('DELETE FROM app.user_corporations WHERE user_id=$1', [u.id]);
        await c.query('DELETE FROM app.auth_sessions WHERE user_id=$1', [u.id]);
        await this.log(
          c,
          req,
          'users',
          u.id,
          {
            loginId: u.login_id,
            name: u.display_name,
            customerId: u.customer_id,
            respId: u.resp_id,
            status: u.account_status,
          },
          null,
        );
        // 앞으로 추가될 업무 외래키도 DB 제약이 최종적으로 보호한다. 실패하면 선택 행 전체를 롤백한다.
        try {
          await c.query('DELETE FROM app.users WHERE id=$1', [u.id]);
        } catch (e: any) {
          if (e.code === '23503')
            throw new ConflictException(
              '연결된 업무 데이터가 있어 삭제할 수 없습니다. 정지를 사용해주세요.',
            );
          throw e;
        }
      }
      return { ok: true };
    });
  }
  async review(req: AppRequest, body: any, action: 'approve' | 'reject' | 'suspend') {
    fields(body, ['customerId', 'rows', 'note']);
    if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > 100)
      throw new BadRequestException('1~100개 체크 행을 선택해주세요.');
    const note = text(body.note, 500, action === 'approve');
    return this.change(async (c) => {
      const actor = await this.actor(
        c,
        req,
        { approve: 'ETC1', reject: 'ETC2', suspend: 'ETC3' }[action],
      );
      const customerId = (await this.customer(c, body.customerId)).id,
        seen = new Set();
      this.tenant(actor, customerId);
      for (const r of body.rows) {
        fields(r, ['id', 'version']);
        id(r.id);
        if (seen.has(r.id) || !Number.isInteger(r.version))
          throw new BadRequestException('중복 행 또는 잘못된 버전입니다.');
        seen.add(r.id);
        const u = (
          await c.query(
            'SELECT u.id,u.version,u.resp_id,u.account_status,r.authority_type FROM app.users u LEFT JOIN app.responsibilities r ON r.id=u.resp_id WHERE u.id=$1 AND u.customer_id=$2 FOR UPDATE OF u',
            [r.id, customerId],
          )
        ).rows[0];
        if (!u) throw new ForbiddenException('처리할 사용자가 없습니다.');
        if (u.id === actor.id || u.authority_type === 'SYSTEM')
          throw new ForbiddenException('자신 또는 운영자는 처리할 수 없습니다.');
        if (u.version !== r.version)
          throw new ConflictException('다른 작업에서 변경했습니다. 다시 조회해주세요.');
        if (
          action === 'approve'
            ? !['PENDING', 'REJECTED', 'SUSPENDED'].includes(u.account_status)
            : action === 'suspend'
              ? u.account_status !== 'ACTIVE'
              : u.account_status !== 'PENDING'
        )
          throw new ConflictException('현재 상태에서는 처리할 수 없습니다.');
        // 승인은 저장된 RESP만 사용한다. 승인 권한으로 RESP 수정 권한을 우회하지 못하게 한다.
        const respId = u.resp_id;
        if (action === 'approve') {
          if (!respId) throw new BadRequestException('사용자 수정에서 RESP를 먼저 지정해주세요.');
          await this.resp(c, respId);
          if (u.account_status !== 'PENDING' && !note)
            throw new BadRequestException('재승인 사유를 입력해주세요.');
        }
        const status = { approve: 'ACTIVE', reject: 'REJECTED', suspend: 'SUSPENDED' }[action];
        await c.query(
          `UPDATE app.users SET account_status=$2,is_active=$3,resp_id=CASE WHEN $3 THEN $4::bigint ELSE resp_id END,
          reviewed_by=$5,reviewed_at=now(),review_note=$6,updated_at=now() WHERE id=$1`,
          [
            u.id,
            status,
            action === 'approve',
            action === 'approve' ? respId : null,
            actor.id,
            note,
          ],
        );
        const event = await this.audit.write(
          {
            requestId: req.requestId,
            userId: actor.id,
            action: 'USER_' + action.toUpperCase(),
            outcome: 'SUCCESS',
          },
          c,
        );
        await c.query(
          'INSERT INTO audit.audit_changes(event_id,entity_type,entity_key,change_type,before_values,after_values) VALUES($1,$2,$3,$4,$5,$6)',
          [
            event,
            'users',
            u.id,
            'UPDATE',
            { status: u.account_status, respId: u.resp_id },
            { status, note, respId: action === 'approve' ? respId : undefined },
          ],
        );
      }
      return { ok: true };
    });
  }
}
@Controller('api')
export class AccountsController {
  constructor(private readonly accounts: Accounts) {}
  @Get('signup/:code') @Public() publicOptions(@Param('code') code: string) {
    return this.accounts.publicOptions(code);
  }
  @Post('signup/:code') @Public() signup(
    @Req() req: AppRequest,
    @Param('code') code: string,
    @Body() body: any,
  ) {
    return this.accounts.create(req, body, code);
  }
  @Get('catalogs/:kind') @CatalogPermission('QUERY') catalogs(
    @Req() req: AppRequest,
    @Param('kind') kind: string,
  ) {
    return this.accounts.catalogs(req, kind);
  }
  @Post('catalogs/:kind/save') @CatalogPermission('SAVE') saveCatalog(
    @Req() req: AppRequest,
    @Param('kind') kind: string,
    @Body() body: any,
  ) {
    return this.accounts.saveCatalog(req, kind, body);
  }
  @Post('catalogs/:kind/delete') @CatalogPermission('DELETE') deleteCatalog(
    @Req() req: AppRequest,
    @Param('kind') kind: string,
    @Body() body: any,
  ) {
    return this.accounts.saveCatalog(req, kind, body, true);
  }
  @Post('accounts/delete') @Permission('USER_REGISTER', 'DELETE') remove(
    @Req() req: AppRequest,
    @Body() body: any,
  ) {
    return this.accounts.remove(req, body);
  }
  @Post('accounts/password-link') @Permission('USER_REGISTER', 'SAVE') passwordLink(
    @Req() req: AppRequest,
    @Body() body: any,
  ) {
    return this.accounts.resetPassword(req, body);
  }
  @Post('accounts/update') @Permission('USER_REGISTER', 'SAVE') update(
    @Req() req: AppRequest,
    @Body() body: any,
  ) {
    return this.accounts.update(req, body);
  }
  @Post('accounts/mapping') @Permission('USER_REGISTER', 'ETC4') mapping(
    @Req() req: AppRequest,
    @Body() body: any,
  ) {
    return this.accounts.mapping(req, body);
  }
  @Get('accounts/options') @Permission('USER_REGISTER', 'QUERY') options(@Req() req: AppRequest) {
    return this.accounts.options(req);
  }
  @Get('accounts/:customerId') @Permission('USER_REGISTER', 'QUERY') list(
    @Req() req: AppRequest,
    @Param('customerId') id: string,
  ) {
    return this.accounts.list(req, id);
  }
  @Post('accounts') @Permission('USER_REGISTER', 'SAVE') create(
    @Req() req: AppRequest,
    @Body() body: any,
  ) {
    return this.accounts.create(req, body);
  }
  @Post('accounts/approve') @Permission('USER_REGISTER', 'ETC1') approve(
    @Req() req: AppRequest,
    @Body() body: any,
  ) {
    return this.accounts.review(req, body, 'approve');
  }
  @Post('accounts/reject') @Permission('USER_REGISTER', 'ETC2') reject(
    @Req() req: AppRequest,
    @Body() body: any,
  ) {
    return this.accounts.review(req, body, 'reject');
  }
  @Post('accounts/suspend') @Permission('USER_REGISTER', 'ETC3') suspend(
    @Req() req: AppRequest,
    @Body() body: any,
  ) {
    return this.accounts.review(req, body, 'suspend');
  }
}
