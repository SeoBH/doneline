/**
 * 업체(워크스페이스) 셀프 가입. 새 워크스페이스와 첫 관리자 계정을 한 트랜잭션으로 만든다.
 * 첫 관리자는 공통 RESP WORKSPACE_ADMIN(SYSTEM)을 받아 바로 로그인할 수 있고, 이메일 인증 메일은 발송 보류로 준비한다.
 * 가입이 커밋된 뒤 Doneline 운영팀에 슬랙 알림을 보낸다(알림 실패는 가입에 영향 없음).
 * 관련 모듈: db.ts(워크스페이스 지정), recovery.ts(인증 메일), notifier.ts(운영 알림), 012/013 마이그레이션.
 */
import {
  Body,
  ConflictException,
  Controller,
  HttpException,
  Injectable,
  Post,
  Req,
} from '@nestjs/common';
import { IsEmail, IsString, Length, Matches } from 'class-validator';
import { createHash } from 'node:crypto';
import * as argon2 from 'argon2';
import { Db, useWorkspace } from './db';
import { Audit } from './audit';
import { Recovery, emailAddress } from './recovery';
import { Notifier } from './notifier';
import { AppRequest, Public } from './security';

// DTO: 요청 본문의 형식을 선언한다. 전역 ValidationPipe가 형식이 틀리거나 선언되지 않은 필드가 있으면 400으로 거절한다.
class WorkspaceSignupDto {
  @IsString() @Matches(/^[a-z0-9][a-z0-9-]{1,39}$/) workspaceCode!: string;
  @IsString() @Length(1, 120) workspaceName!: string;
  @IsString() @Length(1, 80) @Matches(/^[A-Za-z0-9_.-]+$/) loginId!: string;
  @IsString() @Length(1, 120) name!: string;
  @IsEmail() @Length(3, 254) email!: string;
  @IsString() @Matches(/^[+0-9() -]{7,30}$/) mobile!: string;
  @IsString() @Length(15, 128) password!: string;
}

@Injectable()
export class Workspaces {
  constructor(
    private readonly db: Db,
    private readonly audit: Audit,
    private readonly recovery: Recovery,
    private readonly notifier: Notifier,
  ) {}
  async signup(req: AppRequest, body: WorkspaceSignupDto) {
    // 비싼 비밀번호 해시 계산과 업체 생성 전에 IP별 요청 수를 제한한다(15분 5회).
    const bucket =
      'workspace-signup:' +
      createHash('sha256')
        .update(req.ip || '')
        .digest('hex');
    const limit = await this.db.query(
      `INSERT INTO app.login_limits VALUES($1,1,now()+interval '15 minutes') ON CONFLICT(bucket)
      DO UPDATE SET attempts=CASE WHEN app.login_limits.expires_at<=now() THEN 1 ELSE app.login_limits.attempts+1 END,
      expires_at=CASE WHEN app.login_limits.expires_at<=now() THEN now()+interval '15 minutes' ELSE app.login_limits.expires_at END RETURNING attempts`,
      [bucket],
    );
    if (limit.rows[0].attempts > 5)
      throw new HttpException('가입 요청이 많습니다. 잠시 후 다시 시도해주세요.', 429);
    const email = emailAddress(body.email);
    const hash = await argon2.hash(body.password);
    let workspaceId: string;
    try {
      workspaceId = await this.db.tx(async (c) => {
        // 1) 워크스페이스 생성(RLS 밖에서 실행되는 DB 함수). 2) 같은 트랜잭션의 범위를 새 워크스페이스로 지정.
        // 3) 그 안에서 관리자 계정·인증 메일·감사 기록을 만든다. 어느 단계든 실패하면 모두 롤백된다.
        const id = String(
          (
            await c.query('SELECT app.create_workspace($1,$2) AS id', [
              body.workspaceCode,
              body.workspaceName.trim(),
            ])
          ).rows[0].id,
        );
        await c.query("SELECT set_config('app.workspace_id', $1, true)", [id]);
        const resp = (
          await c.query(
            "SELECT id FROM app.responsibilities WHERE code='WORKSPACE_ADMIN' AND workspace_id IS NULL AND is_active",
          )
        ).rows[0];
        if (!resp) throw new Error('WORKSPACE_ADMIN responsibility is missing');
        const user = (
          await c.query(
            `INSERT INTO app.users(login_id,password_hash,display_name,resp_id,is_active,must_change_password,mobile,email,account_status,registration_source,reviewed_at)
            VALUES($1,$2,$3,$4,true,false,$5,$6,'ACTIVE','SIGNUP',now()) RETURNING id,email,display_name`,
            [body.loginId, hash, body.name.trim(), resp.id, body.mobile, email],
          )
        ).rows[0];
        await this.audit.write(
          {
            requestId: req.requestId,
            userId: user.id,
            action: 'WORKSPACE_SIGNUP',
            outcome: 'SUCCESS',
          },
          c,
        );
        await this.recovery.issue(c, user, 'VERIFY');
        return id;
      });
    } catch (e: any) {
      // 23505=고유값 중복. 어떤 값이 겹쳤는지만 알려주고 다른 업체의 정보는 노출하지 않는다.
      if (e?.code === '23505')
        throw new ConflictException(
          String(e.constraint).includes('workspaces')
            ? '이미 사용 중인 업체 코드입니다.'
            : '이미 사용 중인 아이디입니다.',
        );
      throw e;
    }
    // 이후 이 요청의 오류 감사 기록도 새 워크스페이스에 남도록 지정한다.
    useWorkspace(workspaceId);
    // 업체명·코드만 보낸다. 담당자 이름·연락처·이메일 같은 개인정보는 외부 서비스(슬랙)로 보내지 않는다.
    void this.notifier.ops(
      `🆕 새 업체 가입: ${body.workspaceName.trim()} (${body.workspaceCode}) · 요금제 FREE`,
    );
    return {
      message:
        '업체 가입을 완료했습니다. 아이디와 비밀번호로 로그인해주세요. 이메일 인증 메일은 발송 보류입니다.',
    };
  }
}

@Controller('api/workspaces')
export class WorkspacesController {
  constructor(private readonly workspaces: Workspaces) {}
  @Post('signup') @Public() signup(@Req() req: AppRequest, @Body() body: WorkspaceSignupDto) {
    return this.workspaces.signup(req, body);
  }
}
