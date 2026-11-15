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
import { settings } from './config';
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
    throw new BadRequestException('선택값을 확인해 주세요.');
  return v;
};
const text = (v: unknown, max: number, optional = false) => {
  if (typeof v !== 'string' || v.length > max || (!optional && !v.trim()))
    throw new BadRequestException('필수 입력과 길이를 확인해 주세요.');
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
// 메일 발송(SMTP) 설정 여부. 링크를 메일로 보냈는지에 따라 관리자 안내 문구가 달라진다.
const mailed = Boolean(settings.smtp.host);
/**
 * 감사 기록에 남길 값에서 비밀값을 뺀다(QA DLV2-001).
 * 고객사 행의 signup_token(가입 링크 토큰)은 아는 사람 누구나 그 고객사로 가입할 수 있는 열쇠라서
 * 감사 로그를 볼 수 있는 사람에게도 보이면 안 된다. 기록에는 '바뀌었는지'만 남긴다.
 */
function auditValues(row: any) {
  if (!row || typeof row !== 'object' || !('signup_token' in row)) return row;
  const { signup_token: _token, ...rest } = row;
  return rest;
}
// 감사 기록에서 사람이 알아볼 수 없는 참조 번호 칸 → 이름을 찾을 표(QA DLV3-001).
// 예: 법인 행의 customer_id=5는 '고객사 5번'일 뿐이라, 기록 시점의 'CODE 이름'으로 바꿔 남긴다.
const AUDIT_REFS: Record<string, string> = {
  customer_id: 'app.customers',
  customerId: 'app.customers',
  corporation_id: 'app.corporations',
  department_id: 'app.departments',
  resp_id: 'app.responsibilities',
  respId: 'app.responsibilities',
};
/**
 * 감사 기록 값의 참조 번호를 'CODE 이름' 글자로 바꾼다. 비밀값 제거(auditValues)도 함께 한다.
 * 입력: DB 행 또는 { corporations: [{corporation_id}], ... } 같은 요약 객체. 출력: 화면에 그대로 보여 줄 수 있는 객체.
 * 이름을 찾지 못하면(이미 삭제됨 등) 번호를 그대로 둔다. 같은 트랜잭션(c)에서 읽어 저장 직후의 이름이 남는다.
 */
async function readableAudit(c: PoolClient, row: any) {
  const v = auditValues(row);
  if (!v || typeof v !== 'object') return v;
  const label = async (table: string, key: unknown) => {
    if (key === null || key === undefined || key === '') return key;
    const r = (
      await c.query(`SELECT code||' '||name AS label FROM ${table} WHERE id=$1::bigint`, [key])
    ).rows[0];
    return r?.label ?? key;
  };
  const out: any = { ...v };
  for (const [k, table] of Object.entries(AUDIT_REFS))
    if (k in out) out[k] = await label(table, out[k]);
  // 법인·부서 지정 기록은 [{corporation_id: 3}, ...] 또는 [3, 4] 모양이라 하나씩 이름으로 바꾼다.
  for (const [k, table] of [
    ['corporations', 'app.corporations'],
    ['departments', 'app.departments'],
  ] as const)
    if (Array.isArray(out[k]))
      out[k] = await Promise.all(
        out[k].map((x: any) =>
          label(table, typeof x === 'object' ? (x?.corporation_id ?? x?.department_id) : x),
        ),
      );
  return out;
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
      throw new BadRequestException('지정할 수 있는 역할을 선택해 주세요.');
    return r;
  }
  private async log(
    c: PoolClient,
    req: AppRequest,
    kind: string,
    key: string,
    before: any,
    after: any,
    // 기본 기능 코드: 저장은 KIND_SAVE, 삭제(after 없음)는 KIND_DELETE. 예전에는 삭제도 _SAVE로 남아 '저장'처럼 보였다.
    action = kind.toUpperCase() + (after ? '_SAVE' : '_DELETE'),
  ) {
    const event = await this.audit.write(
      {
        requestId: req.requestId,
        userId: req.actor!.id,
        action,
        outcome: 'SUCCESS',
      },
      c,
    );
    await c.query(
      'INSERT INTO audit.audit_changes(event_id,entity_type,entity_key,change_type,before_values,after_values) VALUES($1,$2,$3,$4,$5,$6)',
      [
        event,
        kind,
        key,
        !after ? 'DELETE' : !before ? 'INSERT' : 'UPDATE',
        await readableAudit(c, before),
        await readableAudit(c, after),
      ],
    );
  }
  private async change<T>(fn: (c: PoolClient) => Promise<T>) {
    try {
      return await this.db.tx(fn);
    } catch (e: any) {
      if (e instanceof HttpException) throw e;
      if (e.code === '23505') throw new ConflictException('이미 사용 중인 아이디 또는 코드입니다.');
      if (e.code?.startsWith('23'))
        throw new BadRequestException('연결된 데이터와 입력값을 확인해 주세요.');
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
      throw new BadRequestException('1~500개 행을 선택해 주세요.');
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
        throw new BadRequestException('해당 고객사의 법인을 선택해 주세요.');
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
          throw new ConflictException('다른 작업에서 변경했습니다. 다시 조회해 주세요.');
        if (
          before &&
          kind !== 'customers' &&
          (before.customer_id !== body.customerId ||
            (kind === 'departments' && before.corporation_id !== body.corporationId))
        )
          throw new ForbiddenException('선택한 상위 코드와 다른 행입니다.');
        let after = null;
        if (remove) {
          if (!before) throw new BadRequestException('신규 행은 행삭제로 제거해 주세요.');
          await c.query('DELETE FROM app.' + kind + ' WHERE id=$1', [r.id]);
        } else {
          const code = text(r.code, 40),
            name = text(r.name, 120);
          if (!/^[A-Za-z0-9_-]+$/.test(code))
            throw new BadRequestException('코드는 영문·숫자·밑줄·하이픈으로 입력해 주세요.');
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
  /**
   * 고객사 가입 링크 교체(QA DLV2-001 후속). 링크가 밖으로 퍼졌을 때 새 토큰을 만들어 예전 링크를 바로 무효로 한다.
   * 이미 가입한 사용자에게는 영향이 없고, 새 링크를 받은 사람만 이후 가입할 수 있다.
   * 감사 기록에는 토큰 값 없이 '교체했다'는 사실만 남긴다. 반환: 새 토큰과 버전(화면의 동시 편집 검사용).
   */
  async rotateSignupLink(req: AppRequest, customerId: string) {
    return this.change(async (c) => {
      const actor = await this.actor(c, req, 'SAVE', catalogCodes.customers);
      await this.customer(c, customerId);
      this.tenant(actor, customerId);
      // 기본값과 같은 방식(무작위 UUID 2개 = 64자 16진수)으로 새 토큰을 만든다.
      const row = (
        await c.query(
          "UPDATE app.customers SET signup_token=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','') WHERE id=$1 RETURNING id,signup_token,version",
          [id(customerId)],
        )
      ).rows[0];
      await this.log(
        c,
        req,
        'customers',
        row.id,
        { signupLink: '이전 링크' },
        { signupLink: '새 링크로 교체' },
        'SIGNUP_LINK_ROTATE',
      );
      return {
        signupToken: row.signup_token,
        version: row.version,
        message: '가입 링크를 새로 만들었습니다. 예전 링크는 더 이상 쓸 수 없습니다.',
      };
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
      // 고객사별 사용자 수·승인 대기 수. 화면의 고객사 고르기 칸에 함께 보여, 다른 고객사에 승인할 사람이
      // 있는데도 '없다'고 오해하지 않게 한다(QA DLV2-005). customer_id가 NULL인 줄은 우리 업체 직원이다.
      const counts = (
        await c.query(
          `SELECT customer_id, count(*)::int AS users, (count(*) FILTER (WHERE account_status='PENDING'))::int AS pending
           FROM app.users WHERE ($1 OR customer_id=$2) GROUP BY customer_id`,
          [actor.authority_type === 'SYSTEM', actor.customer_id],
        )
      ).rows;
      const countOf = (key: string | null) =>
        counts.find((r) => r.customer_id === key) || { users: 0, pending: 0 };
      for (const t of customers) Object.assign(t, { counts: countOf(t.id) });
      const responsibilities = (
        await c.query(
          "SELECT id,code,name,authority_type,level FROM app.responsibilities WHERE is_active AND ($1 OR authority_type='CUSTOMER') ORDER BY code",
          [actor.authority_type === 'SYSTEM'],
        )
      ).rows;
      return {
        operator: actor.authority_type === 'SYSTEM',
        customers,
        responsibilities,
        staffCounts: actor.authority_type === 'SYSTEM' ? countOf(null) : undefined,
      };
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
    if (!t)
      throw new NotFoundException(
        '가입 링크가 올바르지 않거나 사용이 중지되었습니다. 링크를 보내 준 업체 담당자에게 새 링크를 요청해 주세요.',
      );
    useWorkspace(t.workspace_id);
    return String(t.customer_id);
  }
  /** 가입 화면에 보여 줄 고객사·업체 이름. 추측할 수 없는 가입 토큰을 가진 사람에게만 응답한다. */
  async publicOptions(token: string) {
    const customerId = await this.signupTarget(token);
    return this.db.tx(async (c) => {
      const customer = (await c.query('SELECT name FROM app.customers WHERE id=$1', [customerId]))
        .rows[0];
      const workspace = (await c.query('SELECT name FROM app.workspaces')).rows[0];
      return { ok: true, customerName: customer?.name, workspaceName: workspace?.name };
    });
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
          body.password.length < 8 ||
          body.password.length > 128))
    )
      throw new BadRequestException('아이디·휴대전화·비밀번호(8~128자)를 확인해 주세요.');
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
        throw new HttpException('가입 요청이 많습니다. 잠시 후 다시 시도해 주세요.', 429);
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
        if (!t)
          throw new NotFoundException(
            '가입 링크가 올바르지 않거나 사용이 중지되었습니다. 링크를 보내 준 업체 담당자에게 새 링크를 요청해 주세요.',
          );
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
        throw new BadRequestException('고객사를 선택해 주세요.');
      if (resp?.authority_type === 'SYSTEM' && customerId)
        throw new BadRequestException('업체 직원 역할은 고객사를 지정하지 않습니다.');
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
      // 관리자 등록: 24시간 유효 링크를 메일로 보내고(SMTP 설정 시), 메일이 닿지 않을 때 관리자가 직접 전달하도록 화면에도 돌려준다.
      const link = await this.recovery.issue(
        c,
        user,
        actor ? 'PASSWORD' : 'VERIFY',
        actor ? 24 : 0.5,
      );
      if (!actor) {
        // 공개 가입 신청: 승인할 수 있는 사람에게 앱 안 알림을 남긴다.
        // 업체 직원(SYSTEM) 전체와, 같은 고객사의 활성 고객사 관리자(CUSTOMER_MANAGER)다. 고객사 관리자도 자기 고객사
        // 직원을 승인할 수 있으므로, 고객사 직원이 많아져도 승인이 업체에만 몰리지 않게 한다.
        const customer = (await c.query('SELECT name FROM app.customers WHERE id=$1', [customerId]))
          .rows[0];
        await c.query(
          `INSERT INTO app.notifications(user_id,message) SELECT u.id,$1 FROM app.users u JOIN app.account_access a ON a.id=u.id
           JOIN app.responsibilities p ON p.id=u.resp_id
           WHERE a.account_enabled AND (a.authority_type='SYSTEM' OR (p.code='CUSTOMER_MANAGER' AND u.customer_id=$2))`,
          [
            `새 가입 신청: ${name} (${customer?.name || '고객사'}) · 사용자등록에서 승인해 주세요`.slice(
              0,
              300,
            ),
            customerId,
          ],
        );
      }
      return actor
        ? {
            message:
              (mailed
                ? '등록했습니다. 비밀번호 설정 링크를 직원 이메일로 보냈습니다(24시간 유효). 받은편지함에 없으면 스팸함 확인을 안내하고, 그래도 없으면 아래 링크를 직접 전달해 주세요.'
                : '등록했습니다. 비밀번호 설정 링크를 직원에게 전달해 주세요(24시간 유효).') +
              ' 고객사 사용자는 소속 부서 지정 후 로그인할 수 있습니다.',
            link,
            mailed,
          }
        : {
            // 공개 가입도 이메일 인증 메일(30분 유효)을 보낸다. 메일이 켜져 있을 때만 스팸함 안내를 덧붙인다.
            message:
              '가입 신청을 접수했습니다. 업체 관리자가 승인하고 소속 부서를 지정하면 로그인할 수 있습니다.' +
              (mailed
                ? ' 이메일 인증 메일을 보냈습니다. 받은편지함에 없으면 스팸함도 확인해 주세요.'
                : ''),
            mailed,
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
        throw new ConflictException('다른 작업에서 변경했습니다. 다시 조회해 주세요.');
      if (u.id === actor.id)
        throw new BadRequestException('자신의 계정은 다른 운영담당자에게 변경을 요청해 주세요.');
      const customerId = body.customerId ? (await this.customer(c, body.customerId)).id : null;
      this.tenant(actor, customerId);
      const r = await this.resp(c, body.respId, actor.authority_type === 'SYSTEM');
      if ((r.authority_type === 'SYSTEM') !== !customerId)
        throw new BadRequestException('SYSTEM은 고객사 없음, CUSTOMER는 고객사를 선택해 주세요.');
      // 승인 대기에서 SYSTEM으로 변경하면 공개 신청의 권한 제한이 우회되므로 금지한다.
      if (u.account_status === 'PENDING' && r.authority_type === 'SYSTEM')
        throw new BadRequestException('가입 신청에는 CUSTOMER RESP만 배정할 수 있습니다.');
      const name = text(body.name, 120),
        mobile = text(body.mobile, 30),
        address = text(body.address, 500, true),
        email = body.email === undefined ? u.email : emailAddress(body.email);
      if (!/^[+0-9() -]{7,30}$/.test(mobile))
        throw new BadRequestException('휴대전화번호를 확인해 주세요.');
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
      if (u.version !== body.version) throw new ConflictException('다시 조회해 주세요.');
      if (['REJECTED', 'SUSPENDED'].includes(u.account_status))
        throw new BadRequestException('반려·정지 계정은 재승인 후 처리해 주세요.');
      const link = await this.recovery.issue(c, u, 'PASSWORD', 24);
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
          (mailed
            ? '비밀번호 설정 링크를 사용자 이메일로 보냈습니다(24시간 유효). 받은편지함에 없으면 스팸함 확인을 안내하고, 그래도 없으면 아래 링크를 직접 전달해 주세요.'
            : '비밀번호 설정 링크를 만들었습니다. 사용자에게 전달해 주세요(24시간 유효).') +
          ' 기존 비밀번호는 링크를 쓰기 전까지 유지됩니다.',
        link,
        mailed,
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
        a.authority_type,a.mapping_ready,r.code AS resp_code,r.name AS resp_name,r.level AS resp_level,
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
        throw new BadRequestException('승인 완료된 사용자를 선택해 주세요.');
      if (u.version !== body.version)
        throw new ConflictException('다른 작업에서 변경했습니다. 다시 조회해 주세요.');
      const ids = (v: any) => {
        if (!Array.isArray(v) || v.length > 500 || new Set(v).size !== v.length)
          throw new BadRequestException('중복 없는 0~500개 항목을 선택해 주세요.');
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
        throw new BadRequestException('고객사·법인·부서 조합을 확인해 주세요.');
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
      throw new BadRequestException('1~100개 행을 선택해 주세요.');
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
        if (!u) throw new ConflictException('이미 삭제된 사용자입니다. 다시 조회해 주세요.');
        this.tenant(actor, u.customer_id);
        if (u.id === actor.id) throw new ForbiddenException('본인 계정은 삭제할 수 없습니다.');
        if (actor.authority_type !== 'SYSTEM' && u.authority_type === 'SYSTEM')
          throw new ForbiddenException('SYSTEM 계정은 삭제할 수 없습니다.');
        if (u.version !== row.version)
          throw new ConflictException('다른 작업에서 변경했습니다. 다시 조회해 주세요.');
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
            '승인 또는 업무 처리 이력이 있는 계정은 삭제할 수 없습니다. 정지를 사용해 주세요.',
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
              '연결된 업무 데이터가 있어 삭제할 수 없습니다. 정지를 사용해 주세요.',
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
      throw new BadRequestException('1~100개 체크 행을 선택해 주세요.');
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
          throw new ConflictException('다른 작업에서 변경했습니다. 다시 조회해 주세요.');
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
          if (!respId) throw new BadRequestException('역할을 먼저 지정해 주세요.');
          await this.resp(c, respId);
          if (u.account_status !== 'PENDING' && !note)
            throw new BadRequestException('재승인 사유를 입력해 주세요.');
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
            // 역할 번호를 'CODE 이름'으로 바꿔 남긴다(QA 4차 DV4-001: 이 경로만 번호 2가 그대로 보였다).
            await readableAudit(c, { status: u.account_status, respId: u.resp_id }),
            await readableAudit(c, {
              status,
              note,
              respId: action === 'approve' ? respId : undefined,
            }),
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
  // :kind는 권한 검사(CatalogPermission)가 화면을 고르는 데 쓰므로 customers만 허용한다.
  @Post('catalogs/:kind/:id/signup-link') @CatalogPermission('SAVE') rotateSignupLink(
    @Req() req: AppRequest,
    @Param('kind') kind: string,
    @Param('id') customerId: string,
  ) {
    if (kind !== 'customers') throw new NotFoundException('등록 화면이 없습니다.');
    return this.accounts.rotateSignupLink(req, customerId);
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
