/**
 * 고객 요청(SR) 접수·처리와 앱 안 알림.
 * - 고객 요청(portal, 화면 SR_PORTAL): 고객사 사용자가 본인 법인·부서 매핑 범위의 요청만 보고 등록·댓글·완료 확인한다.
 * - 요청 작업함(desk, 화면 SR_DESK): 업체 SYSTEM 계정이 자기 워크스페이스의 모든 요청을 배정·처리한다.
 * 워크스페이스 분리는 DB 행 수준 보안이 맡고(012/014 마이그레이션), 이 파일은 고객사·부서 범위와 상태 규칙을 맡는다.
 * 상태·담당자 변경은 version으로 동시 편집 충돌을 검사하고, 변경과 이력·알림·감사 기록을 한 트랜잭션으로 저장한다.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
} from 'class-validator';
import { PoolClient } from 'pg';
import { Db } from './db';
import { Audit } from './audit';
import { AppRequest, Permission } from './security';
import { slaFor } from './sla';

const CATEGORIES = ['INCIDENT', 'REQUEST', 'QUESTION'] as const;
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
const STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'CANCELLED'] as const;
// 진행 동작별로 허용되는 현재 상태와 바뀌는 상태. RESOLVED→CLOSED(완료)는 고객 확인(portal)만 가능하고,
// RESOLVED→IN_PROGRESS는 고객의 재처리 요청으로만 일어난다(담당자가 스스로 완료를 취소하지 않는다).
const DESK_FLOW: Record<string, { from: string[]; to: string }> = {
  START: { from: ['OPEN'], to: 'IN_PROGRESS' },
  RESOLVE: { from: ['IN_PROGRESS'], to: 'RESOLVED' },
  REVERT: { from: ['IN_PROGRESS'], to: 'OPEN' },
  CANCEL: { from: ['OPEN', 'IN_PROGRESS'], to: 'CANCELLED' },
};
const ID = /^\d{1,18}$/;
// 알림 문구에 쓰는 상태 이름. 고객에게 영문 코드를 보이지 않는다.
const STATUS_LABEL: Record<string, string> = {
  OPEN: '접수',
  IN_PROGRESS: '처리 중',
  RESOLVED: '확인 대기',
  CLOSED: '완료',
  CANCELLED: '취소',
};

class CreateDto {
  @IsString() @Length(1, 200) title!: string;
  @IsString() @Length(1, 10000) body!: string;
  @IsIn(CATEGORIES) category!: string;
  @IsIn(PRIORITIES) priority!: string;
  @IsString() @Matches(ID) corporationId!: string;
  @IsString() @Matches(ID) departmentId!: string;
}
class CommentDto {
  @IsString() @Length(1, 10000) body!: string;
}
class VersionDto {
  @IsInt() @Min(1) version!: number;
  // 재처리 요청 사유. 완료 확인에는 쓰지 않고, 재처리 요청에는 필수다(엔지니어가 무엇을 다시 해야 하는지 알 수 있게).
  @IsOptional() @IsString() @Length(1, 2000) reason?: string;
}
// 담당자 화면의 진행 동작. 상태를 직접 고르지 않고 '다음 동작'만 보내 단계를 건너뛰거나 거꾸로 가지 않게 한다.
// START: 담당 지정과 동시에 처리 시작(접수→처리 중) / RESOLVE: 처리 완료(처리 중→고객 확인 대기)
// REVERT: 되돌리기(처리 중→접수, 담당 해제, 사유 필수) / CANCEL: 요청 취소(접수·처리 중→취소, 사유 필수)
const DESK_ACTIONS = ['START', 'RESOLVE', 'REVERT', 'CANCEL'] as const;
class DeskUpdateDto {
  @IsInt() @Min(1) version!: number;
  @IsOptional() @IsIn(DESK_ACTIONS) action?: string;
  // START에서는 맡길 사람(없으면 나), 동작 없이 보내면 처리 중 요청의 재배정(관리자만)이다.
  @IsOptional() @IsString() @Matches(/^\d{1,18}$/) assigneeId?: string;
  @IsOptional() @IsIn(PRIORITIES) priority?: string;
  @IsOptional() @IsString() @Length(1, 10000) comment?: string;
  @IsOptional() @IsBoolean() internal?: boolean;
}
class ReadDto {
  @IsArray() @Matches(ID, { each: true }) ids!: string[];
}

// 목록 공통 SELECT. overdue는 종료되지 않은 요청이 기한을 넘겼는지 DB 시각으로 계산한다.
const LIST_SQL = `SELECT r.id,r.request_no,r.title,r.status,r.priority,r.category,r.due_at,r.updated_at,r.created_at,r.version,
  r.customer_id,c.name AS customer_name,co.name AS corporation_name,d.name AS department_name,
  rq.display_name AS requester_name,r.assignee_id,a.display_name AS assignee_name,
  (r.status IN ('OPEN','IN_PROGRESS') AND r.due_at<now()) AS overdue
  FROM app.service_requests r JOIN app.customers c ON c.id=r.customer_id
  JOIN app.corporations co ON co.id=r.corporation_id JOIN app.departments d ON d.id=r.department_id
  JOIN app.users rq ON rq.id=r.requester_id LEFT JOIN app.users a ON a.id=r.assignee_id`;

@Injectable()
export class Requests {
  constructor(
    private readonly db: Db,
    private readonly audit: Audit,
  ) {}
  /** 고객 요청 화면은 고객사 사용자 전용이다. 고객사가 없는 SYSTEM 계정이 쓰면 범위를 정할 수 없어 거절한다. */
  private customerActor(req: AppRequest) {
    const a = req.actor!;
    if (a.authority_type !== 'CUSTOMER' || !a.customer_id)
      throw new ForbiddenException('고객사 사용자만 사용할 수 있는 화면입니다.');
    return a;
  }
  private staffActor(req: AppRequest) {
    if (req.actor!.authority_type !== 'SYSTEM')
      throw new ForbiddenException('업체 담당자만 사용할 수 있는 화면입니다.');
    return req.actor!;
  }
  /**
   * 요청을 누구에게든 배정·재배정할 수 있는 '업체 관리자'인지. 업체 관리자(WORKSPACE_ADMIN)와 운영 관리자(ADMIN)가 해당한다.
   * 엔지니어(WORKSPACE_ENGINEER)는 미배정 요청을 자기에게 가져오거나 자기 담당 요청만 처리한다.
   */
  private async isManager(c: PoolClient, respId: string) {
    const r = await c.query('SELECT code FROM app.responsibilities WHERE id=$1', [respId]);
    return ['WORKSPACE_ADMIN', 'ADMIN'].includes(r.rows[0]?.code);
  }
  // 고객사 사용자가 볼 수 있는 요청: 같은 고객사이고 요청 부서가 본인 법인·부서 매핑에 포함된 것.
  private readonly scopeSql = `r.customer_id=$1 AND EXISTS(SELECT 1 FROM app.user_scopes s
    WHERE s.user_id=$2 AND s.corporation_id=r.corporation_id AND s.department_id=r.department_id)`;

  /** 알림을 여러 사용자에게 한 번에 기록한다. 자기 자신에게는 보내지 않는다. */
  private async notify(
    c: PoolClient,
    users: string[],
    actorId: string,
    requestId: string,
    message: string,
  ) {
    const targets = [...new Set(users.filter((u) => u && u !== actorId))];
    if (!targets.length) return;
    await c.query(
      'INSERT INTO app.notifications(user_id,request_id,message) SELECT unnest($1::bigint[]),$2,$3',
      [targets, requestId, message.slice(0, 300)],
    );
  }
  /**
   * 고객 쪽 알림 대상: 요청자 + 그 요청 부서를 담당하는 고객사 관리자(CUSTOMER_MANAGER).
   * 관리자도 부서 요청의 진행·완료 확인을 챙길 수 있게 한다.
   */
  private async customerTargets(c: PoolClient, r: any) {
    const managers = (
      await c.query(
        `SELECT DISTINCT u.id FROM app.users u JOIN app.responsibilities p ON p.id=u.resp_id
         JOIN app.user_scopes s ON s.user_id=u.id
         WHERE p.code='CUSTOMER_MANAGER' AND u.is_active AND u.customer_id=$1 AND s.department_id=$2`,
        [r.customer_id, r.department_id],
      )
    ).rows.map((x) => String(x.id));
    return [String(r.requester_id), ...managers];
  }
  /** 담당자가 있으면 담당자, 없으면 워크스페이스의 활성 SYSTEM 계정 전체(소규모 팀 기준)에게 알린다. */
  private async staffTargets(c: PoolClient, assigneeId: string | null) {
    if (assigneeId) return [String(assigneeId)];
    return (
      await c.query(
        'SELECT u.id FROM app.users u JOIN app.account_access a ON a.id=u.id WHERE a.authority_type=$1 AND a.account_enabled',
        ['SYSTEM'],
      )
    ).rows.map((r) => String(r.id));
  }
  private async event(
    c: PoolClient,
    requestId: string,
    actorId: string,
    kind: string,
    values: { body?: string; from?: string | null; to?: string | null; internal?: boolean } = {},
  ) {
    await c.query(
      'INSERT INTO app.request_events(request_id,actor_id,kind,body,from_value,to_value,internal) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        requestId,
        actorId,
        kind,
        values.body ?? null,
        values.from ?? null,
        values.to ?? null,
        Boolean(values.internal),
      ],
    );
  }
  private auditWrite(c: PoolClient, req: AppRequest, action: string) {
    return this.audit.write(
      {
        requestId: req.requestId,
        userId: req.actor!.id,
        menuId: req.get('x-menu-id'),
        action,
        outcome: 'SUCCESS',
      },
      c,
    );
  }
  /** 상세 조회. 고객사 사용자는 내부 메모를 받지 않는다. */
  private async detail(
    c: PoolClient,
    id: string,
    where: string,
    args: unknown[],
    includeInternal: boolean,
  ) {
    const item = (
      await c.query(`${LIST_SQL} WHERE r.id=$${args.length + 1} AND ${where}`, [...args, id])
    ).rows[0];
    if (!item) throw new NotFoundException('요청을 찾을 수 없습니다.');
    const body = (await c.query('SELECT body FROM app.service_requests WHERE id=$1', [id])).rows[0]
      .body;
    const events = (
      await c.query(
        `SELECT e.id,e.kind,e.body,e.from_value,e.to_value,e.internal,e.created_at,u.display_name AS actor_name,
         (u.customer_id IS NOT NULL) AS actor_is_customer
         FROM app.request_events e JOIN app.users u ON u.id=e.actor_id
         WHERE e.request_id=$1 AND ($2 OR NOT e.internal) ORDER BY e.id`,
        [id, includeInternal],
      )
    ).rows;
    return { item: { ...item, body }, events };
  }

  // ---------- 고객 요청(portal) ----------
  async portalList(req: AppRequest) {
    const a = this.customerActor(req);
    return this.db.tx(async (c) => {
      const items = (
        await c.query(`${LIST_SQL} WHERE ${this.scopeSql} ORDER BY r.updated_at DESC LIMIT 200`, [
          a.customer_id,
          a.id,
        ])
      ).rows;
      // 등록 화면의 법인·부서 선택지: 본인 매핑 범위만.
      const scopes = (
        await c.query(
          `SELECT s.corporation_id,co.name AS corporation_name,s.department_id,d.name AS department_name
           FROM app.user_scopes s JOIN app.corporations co ON co.id=s.corporation_id JOIN app.departments d ON d.id=s.department_id
           WHERE s.user_id=$1 ORDER BY co.code,d.code`,
          [a.id],
        )
      ).rows;
      return { items, scopes };
    });
  }
  async portalDetail(req: AppRequest, id: string) {
    const a = this.customerActor(req);
    return this.db.tx((c) => this.detail(c, id, this.scopeSql, [a.customer_id, a.id], false));
  }
  async create(req: AppRequest, body: CreateDto) {
    const a = this.customerActor(req);
    return this.db.tx(async (c) => {
      // 선택한 법인·부서가 본인 매핑에 있는지 서버에서 다시 확인한다(화면 선택지만 믿지 않음).
      const scope = await c.query(
        'SELECT 1 FROM app.user_scopes WHERE user_id=$1 AND customer_id=$2 AND corporation_id=$3 AND department_id=$4',
        [a.id, a.customer_id, body.corporationId, body.departmentId],
      );
      if (!scope.rowCount)
        throw new BadRequestException('본인에게 매핑된 법인·부서를 선택해주세요.');
      // 워크스페이스별 요청 번호는 최대값+1로 매긴다. 동시 등록이 같은 번호를 받지 않도록 워크스페이스 단위로 잠근다.
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtext('service_request:' || current_setting('app.workspace_id')))",
      );
      const no = (
        await c.query('SELECT coalesce(max(request_no),0)+1 AS n FROM app.service_requests')
      ).rows[0].n;
      // 기한은 등록 시점에 현재 업체의 SLA(없으면 기본값)로 계산해 저장한다. 이후 SLA를 바꿔도 이 요청의 기한은 그대로다.
      const sla = await slaFor(c, body.priority);
      const row = (
        await c.query(
          `INSERT INTO app.service_requests(request_no,customer_id,corporation_id,department_id,requester_id,title,body,category,priority,due_at,response_due_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+make_interval(hours=>$10),now()+make_interval(hours=>$11)) RETURNING id,request_no`,
          [
            no,
            a.customer_id,
            body.corporationId,
            body.departmentId,
            a.id,
            body.title.trim(),
            body.body.trim(),
            body.category,
            body.priority,
            sla.resolve,
            sla.response,
          ],
        )
      ).rows[0];
      await this.event(c, row.id, a.id, 'CREATED');
      await this.notify(
        c,
        await this.staffTargets(c, null),
        a.id,
        row.id,
        `#${row.request_no} 새 요청: ${body.title.trim()}`,
      );
      await this.auditWrite(c, req, 'SR_CREATE');
      return {
        id: String(row.id),
        requestNo: row.request_no,
        message: `#${row.request_no} 요청을 등록했습니다.`,
      };
    });
  }
  /** 고객 댓글. 종료(CLOSED·CANCELLED)된 요청에는 남길 수 없다. */
  async portalComment(req: AppRequest, id: string, body: CommentDto) {
    const a = this.customerActor(req);
    return this.db.tx(async (c) => {
      const r = (
        await c.query(
          `SELECT r.* FROM app.service_requests r WHERE r.id=$3 AND ${this.scopeSql} FOR UPDATE`,
          [a.customer_id, a.id, id],
        )
      ).rows[0];
      if (!r) throw new NotFoundException('요청을 찾을 수 없습니다.');
      if (['CLOSED', 'CANCELLED'].includes(r.status))
        throw new ConflictException('종료된 요청입니다.');
      await this.event(c, id, a.id, 'COMMENT', { body: body.body.trim() });
      await c.query('UPDATE app.service_requests SET updated_at=now() WHERE id=$1', [id]);
      await this.notify(
        c,
        await this.staffTargets(c, r.assignee_id),
        a.id,
        id,
        `#${r.request_no} 고객 댓글: ${r.title}`,
      );
      await this.auditWrite(c, req, 'SR_COMMENT');
      return { message: '댓글을 등록했습니다.' };
    });
  }
  /** 고객 확인. RESOLVED만 CLOSED(확인 종료) 또는 IN_PROGRESS(재처리 요청)로 바꿀 수 있다. */
  async portalDecide(req: AppRequest, id: string, body: VersionDto, accept: boolean) {
    const a = this.customerActor(req);
    return this.db.tx(async (c) => {
      const r = (
        await c.query(
          `SELECT r.* FROM app.service_requests r WHERE r.id=$3 AND ${this.scopeSql} FOR UPDATE`,
          [a.customer_id, a.id, id],
        )
      ).rows[0];
      if (!r) throw new NotFoundException('요청을 찾을 수 없습니다.');
      if (r.version !== body.version)
        throw new ConflictException('다른 사용자가 먼저 변경했습니다. 다시 조회해주세요.');
      if (r.status !== 'RESOLVED')
        throw new ConflictException('처리 완료된 요청만 확인할 수 있습니다.');
      const reason = body.reason?.trim();
      if (!accept && !reason) throw new BadRequestException('재처리가 필요한 이유를 적어주세요.');
      const to = accept ? 'CLOSED' : 'IN_PROGRESS';
      await c.query(
        `UPDATE app.service_requests SET status=$2,updated_at=now(),
         closed_at=CASE WHEN $2='CLOSED' THEN now() ELSE NULL END,resolved_at=CASE WHEN $2='CLOSED' THEN resolved_at ELSE NULL END WHERE id=$1`,
        [id, to],
      );
      await this.event(c, id, a.id, 'STATUS', { from: r.status, to });
      // 재처리 사유는 처리 이력에 고객 댓글로 남겨 담당자가 바로 볼 수 있게 한다.
      if (!accept && reason)
        await this.event(c, id, a.id, 'COMMENT', { body: '재처리 요청 사유: ' + reason });
      await this.notify(
        c,
        await this.staffTargets(c, r.assignee_id),
        a.id,
        id,
        `#${r.request_no} ${accept ? '고객이 완료를 확인했습니다' : '고객이 재처리를 요청했습니다'}: ${r.title}`,
      );
      await this.auditWrite(c, req, accept ? 'SR_CONFIRM' : 'SR_REOPEN');
      return { message: accept ? '완료를 확인했습니다.' : '재처리를 요청했습니다.' };
    });
  }

  // ---------- 요청 작업함(desk) ----------
  async deskList(req: AppRequest, status = '', filter = 'all') {
    const a = this.staffActor(req);
    if (status && !(STATUSES as readonly string[]).includes(status))
      throw new BadRequestException('상태 값을 확인해주세요.');
    return this.db.tx(async (c) => {
      // filter: all=전체, mine=내 담당, none=미배정. status 빈 값은 종료되지 않은 요청(OPEN·IN_PROGRESS·RESOLVED).
      const items = (
        await c.query(
          `${LIST_SQL} WHERE ($1='' AND r.status IN ('OPEN','IN_PROGRESS','RESOLVED') OR r.status=$1)
           AND ($2<>'mine' OR r.assignee_id=$3) AND ($2<>'none' OR r.assignee_id IS NULL)
           ORDER BY overdue DESC, r.due_at, r.id LIMIT 500`,
          [status, filter, a.id],
        )
      ).rows;
      const assignees = (
        await c.query(
          `SELECT u.id,u.display_name FROM app.users u JOIN app.account_access x ON x.id=u.id
           WHERE x.authority_type='SYSTEM' AND x.account_enabled ORDER BY u.display_name`,
        )
      ).rows;
      // me: 화면이 '내 담당인지·관리자인지'에 따라 변경 칸을 잠그거나 담당자 선택지를 줄이는 데 쓴다(최종 판단은 deskUpdate).
      return {
        items,
        assignees,
        me: { id: String(a.id), manager: await this.isManager(c, a.resp_id) },
      };
    });
  }
  async deskDetail(req: AppRequest, id: string) {
    this.staffActor(req);
    return this.db.tx((c) => this.detail(c, id, 'true', [], true));
  }
  /**
   * 담당자 처리 저장. 진행 동작(action)과 우선순위·답변을 받아 바뀐 항목마다 이력을 남기고 관련자에게 알린다.
   * 상태와 담당자는 한 묶음이다: 접수(OPEN)는 항상 담당자 없음, 처리 중·처리 완료는 항상 담당자 있음.
   * 권한: 담당자가 있는 요청은 담당자 본인과 업체 관리자만 진행·우선순위를 바꾼다(다른 직원은 댓글·내부 메모만).
   *       접수 요청은 엔지니어가 자기에게 맡기거나(START) 취소할 수 있고, 다른 사람에게 맡기는 것은 관리자만 한다.
   */
  async deskUpdate(req: AppRequest, id: string, body: DeskUpdateDto) {
    const a = this.staffActor(req);
    return this.db.tx(async (c) => {
      const r = (await c.query('SELECT * FROM app.service_requests WHERE id=$1 FOR UPDATE', [id]))
        .rows[0];
      if (!r) throw new NotFoundException('요청을 찾을 수 없습니다.');
      if (r.version !== body.version)
        throw new ConflictException('다른 사용자가 먼저 변경했습니다. 다시 조회해주세요.');
      if (['CLOSED', 'CANCELLED'].includes(r.status))
        throw new ConflictException('종료된 요청입니다.');
      const manager = await this.isManager(c, a.resp_id);
      const me = String(a.id);
      const owner = r.assignee_id ? String(r.assignee_id) : null;
      // 이 요청의 진행을 바꿀 수 있는 사람: 관리자, 담당자 본인, 또는 담당자가 아직 없을 때의 업체 직원
      const canDrive = manager || !owner || owner === me;
      const action = body.action || null;
      const comment = body.comment?.trim() || '';
      const priority = body.priority && body.priority !== r.priority ? body.priority : null;
      // 동작 없이 담당자만 보내면 처리 중 요청의 재배정이다.
      const reassign =
        !action && body.assigneeId && body.assigneeId !== owner ? body.assigneeId : null;
      if (!action && !reassign && !priority && !comment)
        throw new BadRequestException('변경된 내용이 없습니다.');
      if ((action || priority) && !canDrive)
        throw new ForbiddenException(
          '담당자 또는 업체 관리자만 진행 상태·우선순위를 바꿀 수 있습니다. 댓글과 내부 메모는 남길 수 있습니다.',
        );
      if (priority && !['OPEN', 'IN_PROGRESS'].includes(r.status))
        throw new BadRequestException('처리 완료된 요청의 우선순위는 바꿀 수 없습니다.');
      let status: string | null = null;
      // undefined: 담당자 변경 없음, null: 담당 해제
      let assignee: string | null | undefined = undefined;
      if (action) {
        const flow = DESK_FLOW[action];
        if (!flow.from.includes(r.status))
          throw new BadRequestException(
            `현재 상태(${STATUS_LABEL[r.status]})에서는 할 수 없는 동작입니다. 다시 조회해주세요.`,
          );
        if (['REVERT', 'CANCEL'].includes(action) && !comment)
          throw new BadRequestException(
            `${action === 'REVERT' ? '되돌리는' : '취소하는'} 사유를 답변/메모 칸에 적어주세요.`,
          );
        status = flow.to;
        if (action === 'START') {
          assignee = body.assigneeId || me;
          if (assignee !== me && !manager)
            throw new ForbiddenException('다른 사람에게 맡기는 것은 업체 관리자만 할 수 있습니다.');
        }
        if (action === 'REVERT') assignee = null;
      }
      if (reassign) {
        if (!manager) throw new ForbiddenException('담당자 변경은 업체 관리자만 할 수 있습니다.');
        if (r.status !== 'IN_PROGRESS')
          throw new BadRequestException('처리 중인 요청만 담당자를 바꿀 수 있습니다.');
        assignee = reassign;
      }
      if (assignee) {
        // 담당자는 같은 워크스페이스의 활성 SYSTEM 계정이어야 한다(RLS로 다른 업체 계정은 보이지 않음).
        const ok = await c.query(
          "SELECT 1 FROM app.account_access WHERE id=$1 AND authority_type='SYSTEM' AND account_enabled",
          [assignee],
        );
        if (!ok.rowCount) throw new BadRequestException('담당자로 지정할 수 없는 계정입니다.');
      }
      // 되돌리기 사유는 업체 내부 사정이므로 내부 메모로, 취소 사유는 고객이 알아야 하므로 공개로 남긴다.
      const note =
        action === 'REVERT'
          ? { body: '되돌림 사유: ' + comment, internal: true }
          : action === 'CANCEL'
            ? { body: '취소 사유: ' + comment, internal: false }
            : comment
              ? { body: comment, internal: Boolean(body.internal) }
              : null;
      await c.query(
        `UPDATE app.service_requests SET status=coalesce($2,status),
         assignee_id=CASE WHEN $3 THEN $4::bigint ELSE assignee_id END,priority=coalesce($5,priority),updated_at=now(),
         resolved_at=CASE WHEN $2='RESOLVED' THEN now() WHEN $2 IS NOT NULL THEN NULL ELSE resolved_at END,
         closed_at=CASE WHEN $2='CANCELLED' THEN now() ELSE closed_at END,
         first_response_at=CASE WHEN first_response_at IS NULL AND $6 THEN now() ELSE first_response_at END WHERE id=$1`,
        // $6: 고객에게 보이는 첫 응답(처리 시작·완료·취소 또는 공개 답변)이면 첫 응답 시각을 한 번만 기록한다(응답 SLA 계산용).
        [
          id,
          status,
          assignee !== undefined,
          assignee ?? null,
          priority,
          Boolean((status && action !== 'REVERT') || (note && !note.internal)),
        ],
      );
      const toRequester: string[] = [];
      if (status) {
        await this.event(c, id, a.id, 'STATUS', { from: r.status, to: status });
        // 되돌리기는 업체 안의 재배정 과정이라 고객에게 알리지 않는다.
        if (action === 'RESOLVE') toRequester.push('처리가 완료되어 확인을 기다립니다');
        else if (action !== 'REVERT')
          toRequester.push(`상태가 '${STATUS_LABEL[status]}'(으)로 바뀌었습니다`);
      }
      if (assignee !== undefined) {
        await this.event(c, id, a.id, 'ASSIGN', { from: owner, to: assignee });
        if (assignee && assignee !== me)
          await this.notify(
            c,
            [assignee],
            a.id,
            id,
            `#${r.request_no} 담당자로 지정되었습니다: ${r.title}`,
          );
      }
      if (action === 'REVERT')
        // 다시 맡을 사람이 필요하므로 업체 직원 전체에게 알린다.
        await this.notify(
          c,
          await this.staffTargets(c, null),
          a.id,
          id,
          `#${r.request_no} 담당이 해제되어 다시 배정이 필요합니다: ${r.title}`,
        );
      if (priority) await this.event(c, id, a.id, 'PRIORITY', { from: r.priority, to: priority });
      if (note) {
        await this.event(c, id, a.id, 'COMMENT', note);
        if (!note.internal && action !== 'CANCEL') toRequester.push('담당자 답변이 등록되었습니다');
      }
      if (toRequester.length)
        await this.notify(
          c,
          await this.customerTargets(c, r),
          a.id,
          id,
          `#${r.request_no} ${toRequester.join(', ')}: ${r.title}`,
        );
      await this.auditWrite(c, req, 'SR_UPDATE');
      return { message: '저장했습니다.' };
    });
  }

  // ---------- 앱 안 알림 ----------
  async notifications(req: AppRequest) {
    return this.db.tx(async (c) => {
      const items = (
        await c.query(
          'SELECT id,request_id,message,read_at,created_at FROM app.notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 30',
          [req.actor!.id],
        )
      ).rows;
      const unread = (
        await c.query(
          'SELECT count(*)::int AS n FROM app.notifications WHERE user_id=$1 AND read_at IS NULL',
          [req.actor!.id],
        )
      ).rows[0].n;
      return { items, unread };
    });
  }
  /** ids가 비어 있으면 본인 알림 전체를 읽음 처리한다. 다른 사용자의 알림 ID는 user_id 조건으로 무시된다. */
  async read(req: AppRequest, body: ReadDto) {
    await this.db.query(
      'UPDATE app.notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL AND (cardinality($2::bigint[])=0 OR id=ANY($2))',
      [req.actor!.id, body.ids],
    );
    return { ok: true };
  }
}

@Controller('api')
export class RequestsController {
  constructor(private readonly requests: Requests) {}
  private id(id: string) {
    if (!ID.test(id)) throw new BadRequestException('요청 번호를 확인해주세요.');
    return id;
  }
  @Get('requests/portal') @Permission('SR_PORTAL', 'QUERY') portalList(@Req() req: AppRequest) {
    return this.requests.portalList(req);
  }
  @Get('requests/portal/:id') @Permission('SR_PORTAL', 'QUERY') portalDetail(
    @Req() req: AppRequest,
    @Param('id') id: string,
  ) {
    return this.requests.portalDetail(req, this.id(id));
  }
  @Post('requests/portal') @Permission('SR_PORTAL', 'SAVE') create(
    @Req() req: AppRequest,
    @Body() body: CreateDto,
  ) {
    return this.requests.create(req, body);
  }
  @Post('requests/portal/:id/comment') @Permission('SR_PORTAL', 'SAVE') comment(
    @Req() req: AppRequest,
    @Param('id') id: string,
    @Body() body: CommentDto,
  ) {
    return this.requests.portalComment(req, this.id(id), body);
  }
  @Post('requests/portal/:id/confirm') @Permission('SR_PORTAL', 'ETC1') confirm(
    @Req() req: AppRequest,
    @Param('id') id: string,
    @Body() body: VersionDto,
  ) {
    return this.requests.portalDecide(req, this.id(id), body, true);
  }
  // 재처리 요청은 확인과 같은 권한(ETC1)을 쓴다. 완료 확인 버튼을 받은 사용자만 결과를 판단한다.
  @Post('requests/portal/:id/reopen') @Permission('SR_PORTAL', 'ETC1') reopen(
    @Req() req: AppRequest,
    @Param('id') id: string,
    @Body() body: VersionDto,
  ) {
    return this.requests.portalDecide(req, this.id(id), body, false);
  }
  @Get('requests/desk') @Permission('SR_DESK', 'QUERY') deskList(
    @Req() req: AppRequest,
    @Query('status') status = '',
    @Query('filter') filter = 'all',
  ) {
    return this.requests.deskList(req, String(status), String(filter));
  }
  @Get('requests/desk/:id') @Permission('SR_DESK', 'QUERY') deskDetail(
    @Req() req: AppRequest,
    @Param('id') id: string,
  ) {
    return this.requests.deskDetail(req, this.id(id));
  }
  @Post('requests/desk/:id') @Permission('SR_DESK', 'SAVE') deskUpdate(
    @Req() req: AppRequest,
    @Param('id') id: string,
    @Body() body: DeskUpdateDto,
  ) {
    return this.requests.deskUpdate(req, this.id(id), body);
  }
  // 알림은 화면 권한과 무관하게 로그인한 본인 것만 다룬다.
  @Get('notifications') notifications(@Req() req: AppRequest) {
    return this.requests.notifications(req);
  }
  @Post('notifications/read') read(@Req() req: AppRequest, @Body() body: ReadDto) {
    return this.requests.read(req, body);
  }
}
