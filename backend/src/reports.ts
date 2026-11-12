/**
 * 월간 리포트. 고객사별 요청 처리 실적(등록·처리·SLA 준수율·평균 처리 시간)을 계산하고 엑셀로 내보낸다.
 * 유지보수 업체가 계약 갱신·정산 때 고객사에 제출하는 근거 자료를 만드는 것이 목적이다.
 * 월 경계는 한국 시간(Asia/Seoul) 기준이다. 워크스페이스 분리는 RLS가 맡고 SYSTEM 계정만 사용한다.
 * 관련: requests.ts(요청 데이터), sla.ts(기한), 015 마이그레이션(SR_REPORT 화면).
 */
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import ExcelJS from 'exceljs';
import { PoolClient } from 'pg';
import { Db } from './db';
import { Audit } from './audit';
import { AppRequest, Permission } from './security';

const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;
const STATUS: Record<string, string> = {
  OPEN: '접수',
  IN_PROGRESS: '처리 중',
  RESOLVED: '확인 대기',
  CLOSED: '완료',
  CANCELLED: '취소',
};
const PRIORITY: Record<string, string> = {
  LOW: '낮음',
  NORMAL: '보통',
  HIGH: '높음',
  URGENT: '긴급',
};
const CATEGORY: Record<string, string> = {
  INCIDENT: '장애',
  REQUEST: '작업 요청',
  QUESTION: '문의',
};

// 월 범위: $1='YYYY-MM'을 한국 시간 그 달 1일 0시~다음 달 1일 0시로 바꿔 timestamptz와 비교한다.
const RANGE = `WITH m AS (SELECT (($1||'-01')::timestamp AT TIME ZONE 'Asia/Seoul') AS s,
  ((($1||'-01')::timestamp + interval '1 month') AT TIME ZONE 'Asia/Seoul') AS e)`;

/**
 * 고객사별 지표.
 * - created: 그 달 등록 / resolved: 그 달 처리 완료(담당자 완료 기준) / closed: 그중 고객 확인까지 끝난 건
 * - resolve_met: 처리 완료 건 중 처리 기한 안에 끝낸 건
 * - response_total/response_met: 그 달 등록 건 중 응답 여부를 판단할 수 있는 건(응답했거나 응답 기한이 지난 건)과 기한 내 응답 건
 * - avg_resolve_hours: 그 달 처리 완료 건의 등록→처리 평균 시간
 * - open_now: 조회 시점에 아직 진행 중인(접수·처리 중·확인 대기) 건
 */
const SUMMARY_SQL = `${RANGE}
SELECT c.id AS customer_id,c.name AS customer_name,
  count(*) FILTER (WHERE r.created_at>=m.s AND r.created_at<m.e)::int AS created,
  count(*) FILTER (WHERE r.resolved_at>=m.s AND r.resolved_at<m.e)::int AS resolved,
  count(*) FILTER (WHERE r.resolved_at>=m.s AND r.resolved_at<m.e AND r.status='CLOSED')::int AS closed,
  count(*) FILTER (WHERE r.resolved_at>=m.s AND r.resolved_at<m.e AND r.resolved_at<=r.due_at)::int AS resolve_met,
  count(*) FILTER (WHERE r.created_at>=m.s AND r.created_at<m.e AND (r.first_response_at IS NOT NULL OR r.response_due_at<now()))::int AS response_total,
  count(*) FILTER (WHERE r.created_at>=m.s AND r.created_at<m.e AND r.first_response_at<=r.response_due_at)::int AS response_met,
  round((avg(extract(epoch FROM r.resolved_at-r.created_at)/3600) FILTER (WHERE r.resolved_at>=m.s AND r.resolved_at<m.e))::numeric,1)::float AS avg_resolve_hours,
  count(*) FILTER (WHERE r.status IN ('OPEN','IN_PROGRESS','RESOLVED'))::int AS open_now
FROM app.customers c CROSS JOIN m LEFT JOIN app.service_requests r ON r.customer_id=c.id
WHERE ($2='' OR c.id=$2::bigint)
GROUP BY c.id,c.name,c.code ORDER BY c.code`;

// 엑셀 상세: 그 달 등록되었거나 처리 완료된 요청.
const DETAIL_SQL = `${RANGE}
SELECT r.request_no,c.name AS customer_name,co.name AS corporation_name,d.name AS department_name,r.title,r.category,r.priority,r.status,
  rq.display_name AS requester_name,a.display_name AS assignee_name,r.created_at,r.first_response_at,r.response_due_at,r.resolved_at,r.due_at,r.closed_at
FROM app.service_requests r CROSS JOIN m JOIN app.customers c ON c.id=r.customer_id
JOIN app.corporations co ON co.id=r.corporation_id JOIN app.departments d ON d.id=r.department_id
JOIN app.users rq ON rq.id=r.requester_id LEFT JOIN app.users a ON a.id=r.assignee_id
WHERE (r.created_at>=m.s AND r.created_at<m.e OR r.resolved_at>=m.s AND r.resolved_at<m.e) AND ($2='' OR r.customer_id=$2::bigint)
ORDER BY c.code,r.request_no`;

const rate = (met: number, total: number) => (total ? Math.round((met / total) * 1000) / 10 : null);
// 엑셀 날짜 칸은 한국 시간 문자열로 쓴다(받는 사람의 PC 시간대와 무관하게 같은 값이 보이도록).
const kst = (v: Date | null) =>
  v ? new Date(v).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16) : '';

@Injectable()
export class Reports {
  constructor(
    private readonly db: Db,
    private readonly audit: Audit,
  ) {}
  private check(req: AppRequest, month: string, customerId: string) {
    if (req.actor!.authority_type !== 'SYSTEM')
      throw new ForbiddenException('업체 계정만 사용할 수 있습니다.');
    if (!MONTH.test(month)) throw new BadRequestException('조회 월(YYYY-MM)을 확인해주세요.');
    if (customerId && !/^\d{1,18}$/.test(customerId))
      throw new BadRequestException('고객사를 확인해주세요.');
  }
  private async summary(c: PoolClient, month: string, customerId: string) {
    const rows = (await c.query(SUMMARY_SQL, [month, customerId])).rows.map((r) => ({
      ...r,
      resolveRate: rate(r.resolve_met, r.resolved),
      responseRate: rate(r.response_met, r.response_total),
    }));
    // 전체 합계 행. 비율은 고객사별 비율의 평균이 아니라 건수 합으로 다시 계산한다.
    const sum = (k: string) => rows.reduce((t, r) => t + (r[k] || 0), 0);
    const resolved = sum('resolved');
    const total = {
      created: sum('created'),
      resolved,
      closed: sum('closed'),
      open_now: sum('open_now'),
      resolveRate: rate(sum('resolve_met'), resolved),
      responseRate: rate(sum('response_met'), sum('response_total')),
      avg_resolve_hours: resolved
        ? Math.round(
            (rows.reduce((t, r) => t + (r.avg_resolve_hours || 0) * r.resolved, 0) / resolved) * 10,
          ) / 10
        : null,
    };
    return { rows, total };
  }
  async monthly(req: AppRequest, month: string, customerId: string) {
    this.check(req, month, customerId);
    return this.db.tx(async (c) => {
      const customers = (await c.query('SELECT id,name FROM app.customers ORDER BY code')).rows;
      return { month, customers, ...(await this.summary(c, month, customerId)) };
    });
  }
  /** 엑셀 파일 생성. 요약 시트(고객사별 지표)와 요청 목록 시트로 구성한다. */
  async workbook(req: AppRequest, month: string, customerId: string) {
    this.check(req, month, customerId);
    const { summary, details, workspace } = await this.db.tx(async (c) => ({
      summary: await this.summary(c, month, customerId),
      details: (await c.query(DETAIL_SQL, [month, customerId])).rows,
      workspace: (await c.query('SELECT name FROM app.workspaces')).rows[0]?.name || '',
      audit: await this.audit.write(
        {
          requestId: req.requestId,
          userId: req.actor!.id,
          menuId: req.get('x-menu-id'),
          action: 'REPORT_EXPORT',
          outcome: 'SUCCESS',
        },
        c,
      ),
    }));
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Doneline';
    const head = (ws: ExcelJS.Worksheet) => {
      // 머리글 행 강조와 틀 고정(스크롤해도 머리글이 보이게).
      ws.getRow(ws.rowCount).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws.getRow(ws.rowCount).eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17627E' } };
      });
      ws.views = [{ state: 'frozen', ySplit: ws.rowCount }];
    };
    const s = wb.addWorksheet('요약');
    s.addRow([`${workspace} 월간 요청 처리 리포트 (${month})`]).font = { bold: true, size: 14 };
    s.addRow(['기준: 한국 시간, 처리 완료=담당자 완료 처리, SLA 준수율=기한 내 건수/대상 건수']);
    s.addRow([]);
    s.addRow([
      '고객사',
      '등록',
      '처리 완료',
      '고객 확인 완료',
      '처리 SLA 준수율(%)',
      '첫 응답 SLA 준수율(%)',
      '평균 처리 시간(시간)',
      '현재 진행 중',
    ]);
    head(s);
    for (const r of summary.rows)
      s.addRow([
        r.customer_name,
        r.created,
        r.resolved,
        r.closed,
        r.resolveRate,
        r.responseRate,
        r.avg_resolve_hours,
        r.open_now,
      ]);
    const t = summary.total;
    s.addRow([
      '합계',
      t.created,
      t.resolved,
      t.closed,
      t.resolveRate,
      t.responseRate,
      t.avg_resolve_hours,
      t.open_now,
    ]).font = { bold: true };
    s.columns.forEach((col, i) => (col.width = i === 0 ? 28 : 18));
    const d = wb.addWorksheet('요청 목록');
    d.addRow([
      '번호',
      '고객사',
      '법인',
      '부서',
      '제목',
      '구분',
      '우선순위',
      '상태',
      '요청자',
      '담당자',
      '등록',
      '첫 응답',
      '응답 기한',
      '처리 완료',
      '처리 기한',
      '고객 확인',
      '처리 SLA',
    ]);
    head(d);
    for (const r of details)
      d.addRow([
        r.request_no,
        r.customer_name,
        r.corporation_name,
        r.department_name,
        r.title,
        CATEGORY[r.category],
        PRIORITY[r.priority],
        STATUS[r.status],
        r.requester_name,
        r.assignee_name || '',
        kst(r.created_at),
        kst(r.first_response_at),
        kst(r.response_due_at),
        kst(r.resolved_at),
        kst(r.due_at),
        kst(r.closed_at),
        r.resolved_at ? (new Date(r.resolved_at) <= new Date(r.due_at) ? '준수' : '초과') : '',
      ]);
    d.columns.forEach((col, i) => (col.width = [8, 18, 14, 14, 36][i] ?? 16));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
}

@Controller('api/reports')
export class ReportsController {
  constructor(private readonly reports: Reports) {}
  @Get('monthly') @Permission('SR_REPORT', 'QUERY') monthly(
    @Req() req: AppRequest,
    @Query('month') month = '',
    @Query('customerId') customerId = '',
  ) {
    return this.reports.monthly(req, String(month), String(customerId));
  }
  // 파일 응답이므로 Express 응답 객체에 직접 쓴다. 검증 오류는 쓰기 전에 발생해 공통 오류 응답으로 처리된다.
  @Get('monthly.xlsx') @Permission('SR_REPORT', 'ETC1') async excel(
    @Req() req: AppRequest,
    @Res() res: Response,
    @Query('month') month = '',
    @Query('customerId') customerId = '',
  ) {
    const file = await this.reports.workbook(req, String(month), String(customerId));
    const name = encodeURIComponent(`Doneline_월간리포트_${month}.xlsx`);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    // filename*=UTF-8'': 한글 파일명을 브라우저가 올바르게 표시하도록 인코딩한다.
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${name}`);
    res.send(file);
  }
}
