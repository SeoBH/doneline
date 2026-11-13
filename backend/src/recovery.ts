/** 이메일 소유 확인과 계정 복구. 공개 응답은 계정 존재 여부를 숨기며 링크 원문은 메일에만 담는다. */
import {
  BadRequestException,
  Body,
  Controller,
  HttpException,
  Injectable,
  Post,
  Req,
} from '@nestjs/common';
import { IsEmail, IsIn, IsString, Length, Matches } from 'class-validator';
import { createHash, randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { PoolClient } from 'pg';
import { Db, useWorkspace } from './db';
import { Audit } from './audit';
import { Mail } from './mail';
import { settings } from './config';
import { AppRequest, Public } from './security';
export function emailAddress(value: unknown): string {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
    throw new BadRequestException('이메일 주소를 확인해주세요.');
  return value.trim().toLowerCase();
}
class RequestDto {
  @IsIn(['ID', 'PASSWORD', 'VERIFY']) kind!: 'ID' | 'PASSWORD' | 'VERIFY';
  // 고객사 가입 링크로 접속했으면 그 링크의 가입 토큰, 아니면 빈 값(SYSTEM 계정 복구).
  @IsString() @Matches(/^([a-f0-9]{64})?$/) signupToken!: string;
  @IsString() @Length(0, 80) loginId!: string;
  @IsEmail() @Length(3, 254) email!: string;
}
class InfoDto {
  @IsString() @Matches(/^[a-f0-9]{64}$/) token!: string;
}
class RedeemDto {
  @IsString() @Matches(/^[a-f0-9]{64}$/) token!: string;
  @IsIn(['VERIFY', 'PASSWORD']) purpose!: 'VERIFY' | 'PASSWORD';
  @IsString() @Length(0, 128) password!: string;
}
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
@Injectable()
export class Recovery {
  constructor(
    private readonly db: Db,
    private readonly mail: Mail,
    private readonly audit: Audit,
  ) {}
  /** IP와 입력 주소별 제한은 실제 계정 조회 전에 갱신한다. 존재하지 않는 계정도 같은 제한을 받는다. */
  async limit(req: AppRequest, email: string) {
    const buckets: [string, number][] = [
      ['recovery-ip:' + digest(req.ip || ''), 30],
      ['recovery-email:' + digest(email), 5],
    ];
    const denied = await this.db.tx(async (c) => {
      let blocked = false;
      for (const [bucket, max] of buckets.sort((a, b) => a[0].localeCompare(b[0]))) {
        const r = await c.query(
          `INSERT INTO app.login_limits VALUES($1,1,now()+interval '15 minutes') ON CONFLICT(bucket)
          DO UPDATE SET attempts=CASE WHEN app.login_limits.expires_at<=now() THEN 1 ELSE app.login_limits.attempts+1 END,
          expires_at=CASE WHEN app.login_limits.expires_at<=now() THEN now()+interval '15 minutes' ELSE app.login_limits.expires_at END RETURNING attempts`,
          [bucket],
        );
        blocked ||= r.rows[0].attempts > max;
      }
      return blocked;
    });
    if (denied) throw new HttpException('요청이 많습니다. 잠시 후 다시 시도해주세요.', 429);
  }
  /**
   * 호출자는 사용자 행을 잠근다. 최신 링크 하나만 유효하며 발급 자체로 기존 비밀번호는 바뀌지 않는다.
   * 링크 원문을 돌려준다. 실제 메일 발송이 연결되기 전까지 관리자가 화면에서 복사해 직접 전달하는 용도다.
   * hours: 유효 시간. 본인이 요청한 복구 링크는 30분, 관리자가 전달하는 링크는 전달 시간을 고려해 24시간.
   */
  async issue(c: PoolClient, user: any, purpose: 'VERIFY' | 'PASSWORD', hours = 0.5) {
    if (!user.email) throw new BadRequestException('사용자정보에 이메일을 먼저 저장해주세요.');
    await c.query('DELETE FROM app.account_tokens WHERE user_id=$1', [user.id]);
    await c.query(
      "UPDATE app.mail_outbox SET status='CANCELLED',payload='' WHERE user_id=$1 AND status='HELD'",
      [user.id],
    );
    const token = randomBytes(32).toString('hex');
    await c.query(
      `INSERT INTO app.account_tokens(token_hash,user_id,purpose,email,expires_at) VALUES($1,$2,$3,$4,now()+make_interval(mins=>$5))`,
      [digest(token), user.id, purpose, user.email, Math.round(hours * 60)],
    );
    // URL fragment는 HTTP 요청·Referer에 포함되지 않는다. 화면이 읽은 뒤 주소창에서도 제거한다.
    const link = settings.origin + '/#account=' + purpose + ':' + token;
    await this.mail.hold(c, user.id, {
      to: user.email,
      subject: purpose === 'VERIFY' ? '이메일 인증 안내' : '비밀번호 설정 안내',
      text: `${user.display_name}님, 아래 링크에서 ${purpose === 'VERIFY' ? '이메일을 인증' : '비밀번호를 설정'}해주세요. 링크는 ${hours >= 1 ? hours + '시간' : Math.round(hours * 60) + '분'} 동안 한 번만 사용할 수 있습니다.\n${link}`,
    });
    return link;
  }
  async request(req: AppRequest, body: RequestDto) {
    const email = emailAddress(body.email);
    await this.limit(req, email);
    // 같은 이메일이 여러 업체(워크스페이스)에 등록될 수 있다. 등록된 워크스페이스만 DB 함수로 찾고
    // 워크스페이스마다 RLS 범위를 지정해 그 안의 계정만 처리한다.
    const workspaces = (
      await this.db.query('SELECT app.recovery_workspaces($1) AS id', [email])
    ).rows.map((r) => String(r.id));
    for (const workspaceId of workspaces) await this.requestIn(workspaceId, email, body);
    // 외부 발송 미연결 상태를 숨기지 않는다. 계정 일치 여부와 무관하게 같은 메시지를 반환한다.
    return {
      message:
        '정보가 일치하면 안내를 준비합니다. 메일 자동 발송은 준비 중이므로, 소속 업체 관리자에게 비밀번호 설정 링크를 요청해주세요.',
    };
  }
  /** 한 워크스페이스 안에서 조건에 맞는 계정에 아이디 안내 또는 일회용 링크를 준비한다. */
  private async requestIn(workspaceId: string, email: string, body: RequestDto) {
    await this.db.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(720260910)');
      const users = (
        await c.query(
          `SELECT u.* FROM app.users u LEFT JOIN app.customers t ON t.id=u.customer_id
        WHERE lower(u.email)=$1 AND (($2='' AND u.customer_id IS NULL) OR (t.signup_token=$2 AND t.is_active))
        AND ($3='ID' OR u.login_id=$4) AND u.account_status NOT IN ('REJECTED','SUSPENDED')
        AND ($3='VERIFY' OR u.email_verified_at IS NOT NULL) ORDER BY u.id LIMIT 20 FOR UPDATE OF u`,
          [email, body.signupToken, body.kind, body.loginId],
        )
      ).rows;
      for (const u of users) {
        if (body.kind === 'ID')
          await this.mail.hold(c, u.id, {
            to: email,
            subject: '아이디 안내',
            text: `등록된 아이디는 ${u.login_id}입니다.`,
          });
        else if (body.kind !== 'VERIFY' || !u.email_verified_at) await this.issue(c, u, body.kind);
      }
    }, workspaceId);
  }
  /** 한 트랜잭션 안에서 만료·용도·현재 이메일을 검사하고 소비한다. 동시 요청 중 하나만 성공한다. */
  async redeem(req: AppRequest, body: RedeemDto) {
    await this.limit(req, 'token:' + digest(body.token));
    if (body.purpose === 'PASSWORD' && body.password.length < 8)
      throw new BadRequestException('비밀번호는 8~128자로 입력해주세요.');
    const hash = body.purpose === 'PASSWORD' ? await argon2.hash(body.password) : null;
    // 토큰 해시로 워크스페이스만 찾고, 이 공개 요청의 이후 DB 작업(감사 기록 포함)을 그 범위로 지정한다.
    const workspaceId: string | null = (
      await this.db.query('SELECT app.token_workspace($1) AS id', [digest(body.token)])
    ).rows[0].id;
    if (!workspaceId)
      throw new BadRequestException('사용할 수 없거나 만료된 링크입니다. 다시 요청해주세요.');
    useWorkspace(workspaceId);
    const loginId: string = await this.db.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(720260910)');
      const u = (
        await c.query(
          `SELECT u.* FROM app.account_tokens t JOIN app.users u ON u.id=t.user_id
        LEFT JOIN app.customers co ON co.id=u.customer_id
        WHERE t.token_hash=$1 AND t.purpose=$2 AND t.expires_at>now() AND t.email=u.email
        AND (u.customer_id IS NULL OR co.is_active) AND u.account_status NOT IN ('REJECTED','SUSPENDED') FOR UPDATE OF u`,
          [digest(body.token), body.purpose],
        )
      ).rows[0];
      if (!u)
        throw new BadRequestException('사용할 수 없거나 만료된 링크입니다. 다시 요청해주세요.');
      await c.query('DELETE FROM app.account_tokens WHERE user_id=$1', [u.id]);
      await c.query(
        "UPDATE app.mail_outbox SET status='CANCELLED',payload='' WHERE user_id=$1 AND status='HELD'",
        [u.id],
      );
      if (hash) {
        await c.query(
          'UPDATE app.users SET password_hash=$2,must_change_password=false,email_verified_at=now(),updated_at=now() WHERE id=$1',
          [u.id, hash],
        );
        await c.query(
          'UPDATE app.auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',
          [u.id],
        );
      } else
        await c.query('UPDATE app.users SET email_verified_at=now(),updated_at=now() WHERE id=$1', [
          u.id,
        ]);
      await this.audit.write(
        {
          requestId: req.requestId,
          userId: u.id,
          action: hash ? 'PASSWORD_RESET' : 'EMAIL_VERIFY',
          outcome: 'SUCCESS',
        },
        c,
      );
      return u.login_id;
    });
    return {
      message:
        body.purpose === 'PASSWORD' ? '비밀번호를 설정했습니다.' : '이메일 인증을 완료했습니다.',
      // 비밀번호를 정한 직후 같은 화면에서 바로 로그인할 수 있도록 아이디를 돌려준다(링크를 가진 본인에게만).
      loginId: body.purpose === 'PASSWORD' ? loginId : undefined,
    };
  }
  /**
   * 링크 화면 안내용: 누구의, 어느 업체 계정인지 보여 준다. 유효한 토큰을 가진 사람에게만 이름과 업체명만 돌려준다.
   * 토큰을 소비하지 않는다(메일 검사기의 GET 요청 등으로 링크가 사라지지 않게).
   */
  async info(token: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new BadRequestException('링크를 확인해주세요.');
    const workspaceId: string | null = (
      await this.db.query('SELECT app.token_workspace($1) AS id', [digest(token)])
    ).rows[0].id;
    if (!workspaceId)
      throw new BadRequestException(
        '사용할 수 없거나 만료된 링크입니다. 관리자에게 새 링크를 요청해주세요.',
      );
    const row = (
      await this.db.query(
        `SELECT u.display_name,w.name AS workspace_name FROM app.account_tokens t JOIN app.users u ON u.id=t.user_id
         JOIN app.workspaces w ON w.id=u.workspace_id WHERE t.token_hash=$1 AND t.expires_at>now()`,
        [digest(token)],
        workspaceId,
      )
    ).rows[0];
    if (!row)
      throw new BadRequestException(
        '사용할 수 없거나 만료된 링크입니다. 관리자에게 새 링크를 요청해주세요.',
      );
    return { name: row.display_name, workspaceName: row.workspace_name };
  }
}
@Controller('api/recovery')
export class RecoveryController {
  constructor(private readonly recovery: Recovery) {}
  @Post('request') @Public() request(@Req() req: AppRequest, @Body() body: RequestDto) {
    return this.recovery.request(req, body);
  }
  @Post('redeem') @Public() redeem(@Req() req: AppRequest, @Body() body: RedeemDto) {
    return this.recovery.redeem(req, body);
  }
  // 토큰은 주소가 아닌 본문으로 받는다(서버 접속 기록에 토큰이 남지 않게).
  @Post('info') @Public() info(@Body() body: InfoDto) {
    return this.recovery.info(body.token);
  }
}
