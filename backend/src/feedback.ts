/**
 * 개선 요청(제품 피드백). 로그인한 모든 사용자가 헤더의 [개선 요청]으로 Doneline 운영팀에 보낸다.
 * 운영 워크스페이스만 수신함 화면(FEEDBACK_INBOX)에서 목록을 보고 처리 상태를 바꾼다(016 마이그레이션의 RLS).
 * 접수 후 운영 슬랙으로 업체 코드·구분·제목만 알린다. 관련: notifier.ts, security.ts(운영 전용 화면 검사).
 */
import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpException,
  Injectable,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, Length, Matches, Min } from 'class-validator';
import { Db } from './db';
import { Audit } from './audit';
import { Notifier } from './notifier';
import { AppRequest, Permission } from './security';

const KINDS = ['IMPROVEMENT', 'BUG', 'QUESTION'] as const;
const STATUSES = ['NEW', 'REVIEWED', 'PLANNED', 'DONE', 'DECLINED'] as const;
const KIND_LABEL: Record<string, string> = { IMPROVEMENT: '개선', BUG: '오류', QUESTION: '문의' };

class FeedbackDto {
  @IsIn(KINDS) kind!: string;
  @IsString() @Length(1, 200) title!: string;
  @IsString() @Length(1, 5000) body!: string;
  @IsOptional() @IsString() @Length(0, 200) page?: string;
}
class StatusDto {
  @IsIn(STATUSES) status!: string;
  @IsInt() @Min(1) version!: number;
}

@Injectable()
export class Feedback {
  constructor(
    private readonly db: Db,
    private readonly audit: Audit,
    private readonly notifier: Notifier,
  ) {}
  async submit(req: AppRequest, body: FeedbackDto) {
    const a = req.actor!;
    const ws = await this.db.tx(async (c) => {
      // 사용자당 1시간 10건으로 제한해 실수로 연속 전송하거나 남용하는 것을 막는다.
      const limit = await c.query(
        `INSERT INTO app.login_limits VALUES($1,1,now()+interval '1 hour') ON CONFLICT(bucket)
        DO UPDATE SET attempts=CASE WHEN app.login_limits.expires_at<=now() THEN 1 ELSE app.login_limits.attempts+1 END,
        expires_at=CASE WHEN app.login_limits.expires_at<=now() THEN now()+interval '1 hour' ELSE app.login_limits.expires_at END RETURNING attempts`,
        ['feedback:' + a.id],
      );
      if (limit.rows[0].attempts > 10)
        throw new HttpException('개선 요청이 많습니다. 잠시 후 다시 보내주세요.', 429);
      const w = (await c.query('SELECT code,name FROM app.workspaces')).rows[0];
      await c.query(
        'INSERT INTO app.feedback(user_id,workspace_name,user_name,kind,title,body,page) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          a.id,
          w.name,
          a.display_name,
          body.kind,
          body.title.trim(),
          body.body.trim(),
          body.page || null,
        ],
      );
      await this.audit.write(
        { requestId: req.requestId, userId: a.id, action: 'FEEDBACK_SUBMIT', outcome: 'SUCCESS' },
        c,
      );
      return w;
    });
    // 커밋 후 운영팀 알림. 본문·작성자 이름은 보내지 않는다(수신함에서 확인).
    void this.notifier.ops(
      `💡 개선 요청(${KIND_LABEL[body.kind]}) [${ws.code}] ${body.title.trim()}`,
    );
    return { message: '개선 요청을 보냈습니다. 감사합니다!' };
  }
  async list() {
    const items = (
      await this.db.query(
        'SELECT * FROM app.feedback ORDER BY (status=$1) DESC, id DESC LIMIT 300',
        ['NEW'],
      )
    ).rows;
    return { items };
  }
  async setStatus(req: AppRequest, id: string, body: StatusDto) {
    return this.db.tx(async (c) => {
      const r = await c.query(
        'UPDATE app.feedback SET status=$2,updated_at=now() WHERE id=$1 AND version=$3',
        [id, body.status, body.version],
      );
      if (!r.rowCount)
        throw new ConflictException('다른 사용자가 먼저 변경했습니다. 다시 조회해주세요.');
      await this.audit.write(
        {
          requestId: req.requestId,
          userId: req.actor!.id,
          menuId: req.get('x-menu-id'),
          action: 'FEEDBACK_STATUS',
          outcome: 'SUCCESS',
        },
        c,
      );
      return { message: '상태를 저장했습니다.' };
    });
  }
}

@Controller('api/feedback')
export class FeedbackController {
  constructor(private readonly feedback: Feedback) {}
  // 화면 권한 없이 로그인한 사용자 누구나 보낼 수 있다(가드가 로그인·CSRF만 검사).
  @Post() submit(@Req() req: AppRequest, @Body() body: FeedbackDto) {
    return this.feedback.submit(req, body);
  }
  @Get() @Permission('FEEDBACK_INBOX', 'QUERY') list() {
    return this.feedback.list();
  }
  @Post(':id/status') @Permission('FEEDBACK_INBOX', 'SAVE') status(
    @Req() req: AppRequest,
    @Param('id') id: string,
    @Body() body: StatusDto,
  ) {
    if (!/^\d{1,18}$/.test(id)) throw new ConflictException('대상을 확인해주세요.');
    return this.feedback.setStatus(req, id, body);
  }
}
