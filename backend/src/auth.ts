/**
 * 로그인·비밀번호 변경·로그아웃 처리. DTO 검증 후 계정을 확인하고 세션을 발급한다.
 * 로그인 성공 감사 기록은 세션 저장 트랜잭션에 포함하며 비밀번호는 해시로 저장한다.
 */
import {
  Body,
  Controller,
  Get,
  HttpException,
  Injectable,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { IsString, Length, Matches } from 'class-validator';
import { Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { Db } from './db';
import { Audit } from './audit';
import { AllowPasswordChange, AppRequest, Public } from './security';
import { PgSessionStore } from './session-store';
class LoginDto {
  @IsString() @Length(1, 80) @Matches(/^[a-zA-Z0-9_.-]+$/) loginId!: string;
  @IsString() @Length(1, 128) password!: string;
}
class PasswordDto {
  @IsString() @Length(1, 128) currentPassword!: string;
  @IsString() @Length(8, 128) newPassword!: string;
}
@Injectable()
export class AuthService {
  // 없는 계정도 Argon2 검증 비용을 치르게 하여 계정 존재 여부에 따른 시간 차이를 줄인다.
  private readonly dummy = argon2.hash(randomBytes(32).toString('hex'));
  constructor(
    private readonly db: Db,
    private readonly audit: Audit,
  ) {}
  async login(req: AppRequest, body: LoginDto) {
    const digest = (v: string) => createHash('sha256').update(v).digest('hex');
    // Persistent limits apply across instances; lock buckets in a stable order.
    // 계정당 5회, IP당 30회를 15분 창으로 제한한다. 잠금 순서를 고정해 교착 가능성을 줄인다.
    const buckets = [
      ['account:' + digest(body.loginId), 5],
      ['ip:' + digest(req.ip || ''), 30],
    ] as const;
    const blocked = await this.db.tx(async (c) => {
      let denied = false;
      for (const [bucket, limit] of [...buckets].sort((a, b) => a[0].localeCompare(b[0]))) {
        const { rows } = await c.query(
          `INSERT INTO app.login_limits(bucket,attempts,expires_at) VALUES($1,1,now()+interval '15 minutes')
     ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN app.login_limits.expires_at<=now() THEN 1 ELSE app.login_limits.attempts+1 END,
     expires_at=CASE WHEN app.login_limits.expires_at<=now() THEN now()+interval '15 minutes' ELSE app.login_limits.expires_at END RETURNING attempts`,
          [bucket],
        );
        denied ||= rows[0].attempts > limit;
      }
      return denied;
    });
    if (blocked) throw new HttpException('로그인 시도가 많습니다. 잠시 후 다시 시도해주세요.', 429);
    // 로그인 전에는 워크스페이스를 모른다. 로그인 ID로 워크스페이스 ID만 찾은 뒤(DB 함수, RLS 밖)
    // 계정 정보는 그 워크스페이스 범위 안에서 RLS를 적용해 다시 읽는다. 없는 ID면 빈 결과가 된다.
    const workspaceId: string | null = (
      await this.db.query('SELECT app.login_workspace($1) AS id', [body.loginId])
    ).rows[0].id;
    const { rows } = workspaceId
      ? await this.db.query(
          `SELECT u.*,a.account_enabled AS resp_active,a.authority_type,w.name AS workspace_name,w.is_platform
           FROM app.users u JOIN app.account_access a ON a.id=u.id JOIN app.workspaces w ON w.id=u.workspace_id
           WHERE login_id=$1 AND a.account_enabled AND a.mapping_ready`,
          [body.loginId],
          workspaceId,
        )
      : { rows: [] };
    const user = rows[0];
    const valid = await argon2.verify(user?.password_hash || (await this.dummy), body.password);
    if (!user || !user.password_hash || !valid || !user.is_active || !user.resp_active) {
      await new Promise((r) => setTimeout(r, 200));
      throw new UnauthorizedException('아이디 또는 비밀번호를 확인해주세요.');
    }
    // 인증 전 세션을 폐기하고 새 ID를 발급해 세션 고정을 방지한다.
    await new Promise<void>((resolve, reject) =>
      req.session.regenerate((e) => (e ? reject(e) : resolve())),
    );
    req.session.userId = user.id;
    req.session.workspaceId = String(user.workspace_id);
    req.session.csrf = randomBytes(32).toString('hex');
    req.session.issuedAt = Date.now();
    req.session.loginRequestId = req.requestId;
    try {
      await new Promise<void>((resolve, reject) =>
        req.session.save((e) => (e ? reject(e) : resolve())),
      );
    } catch (e) {
      await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
      throw e;
    }
    await this.db.query('DELETE FROM app.login_limits WHERE bucket=$1', [buckets[0][0]]);
    return {
      user: {
        id: user.id,
        displayName: user.display_name,
        mustChangePassword: user.must_change_password,
        workspaceName: user.workspace_name,
        staff: user.authority_type === 'SYSTEM',
        platform: user.is_platform,
      },
      csrfToken: req.session.csrf,
    };
  }
  // 사용자 행을 잠그고 현재 비밀번호를 확인한다. DB 트리거가 해당 계정의 기존 세션을 폐기한다.
  async changePassword(req: AppRequest, body: PasswordDto) {
    const hash = await argon2.hash(body.newPassword);
    await this.db.tx(async (c) => {
      const { rows } = await c.query('SELECT password_hash FROM app.users WHERE id=$1 FOR UPDATE', [
        req.actor!.id,
      ]);
      if (!rows[0] || !(await argon2.verify(rows[0].password_hash, body.currentPassword)))
        throw new UnauthorizedException('현재 비밀번호를 확인해주세요.');
      if (await argon2.verify(rows[0].password_hash, body.newPassword))
        throw new HttpException('다른 비밀번호를 사용해주세요.', 400);
      await c.query(
        'UPDATE app.users SET password_hash=$2,must_change_password=false,updated_at=now() WHERE id=$1',
        [req.actor!.id, hash],
      );
      await this.audit.write(
        {
          requestId: req.requestId,
          userId: req.actor!.id,
          action: 'PASSWORD_CHANGE',
          outcome: 'SUCCESS',
        },
        c,
      );
    });
    await new Promise<void>((resolve, reject) =>
      req.session.destroy((e) => (e ? reject(e) : resolve())),
    );
    return { message: '비밀번호를 변경했습니다. 다시 로그인해주세요.' };
  }
}
@Controller('api')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly db: Db,
    private readonly audit: Audit,
    private readonly store: PgSessionStore,
  ) {}
  @Get('auth/csrf')
  @Public()
  async csrf(@Req() req: AppRequest) {
    req.session.csrf ||= randomBytes(32).toString('hex');
    req.session.issuedAt ||= Date.now();
    try {
      await new Promise<void>((resolve, reject) =>
        req.session.save((e) => (e ? reject(e) : resolve())),
      );
    } catch (e) {
      await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
      throw e;
    }
    return { csrfToken: req.session.csrf };
  }
  @Post('auth/login')
  @Public()
  login(@Req() req: AppRequest, @Body() body: LoginDto) {
    return this.auth.login(req, body);
  }
  @Get('me')
  @AllowPasswordChange()
  me(@Req() req: AppRequest) {
    return {
      user: {
        id: req.actor!.id,
        displayName: req.actor!.display_name,
        mustChangePassword: req.actor!.must_change_password,
        // 헤더 표시(어느 업체에서 작업 중인지)와 화면별 안내 분기에 쓴다.
        workspaceName: req.actor!.workspace_name,
        staff: req.actor!.authority_type === 'SYSTEM',
        platform: req.actor!.is_platform,
      },
      csrfToken: req.session.csrf,
    };
  }
  @Post('auth/password')
  @AllowPasswordChange()
  password(
    @Req() req: AppRequest,
    @Body() body: PasswordDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.changePassword(req, body).then((result) => {
      res.clearCookie('doneline.sid', { path: '/' });
      return result;
    });
  }
  @Post('auth/activity')
  @AllowPasswordChange()
  async activity(@Req() req: AppRequest) {
    await this.store.activity(req.sessionID);
    return { ok: true };
  }
  @Post('auth/logout')
  @AllowPasswordChange()
  async logout(@Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    await this.db.tx(async (c) => {
      await c.query('UPDATE app.auth_sessions SET revoked_at=now() WHERE token_hash=$1', [
        this.store.key(req.sessionID),
      ]);
      await this.audit.write(
        { requestId: req.requestId, userId: req.actor!.id, action: 'LOGOUT', outcome: 'SUCCESS' },
        c,
      );
    });
    await new Promise<void>((resolve, reject) =>
      req.session.destroy((e) => (e ? reject(e) : resolve())),
    );
    res.clearCookie('doneline.sid', { path: '/' });
    return { ok: true };
  }
}
