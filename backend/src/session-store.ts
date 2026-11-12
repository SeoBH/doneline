/**
 * PostgreSQL 기반 세션 저장소. 쿠키 ID는 SHA-256 해시로 조회한다.
 * 유휴 만료와 절대 만료를 구분하고 명시적 사용자 활동 API만 유휴 시간을 연장한다.
 */
import session from 'express-session';
import { createHash, randomUUID } from 'node:crypto';
import { Db } from './db';
import { Audit } from './audit';
import { settings } from './config';
declare module 'express-session' {
  interface SessionData {
    userId?: string;
    // 로그인한 사용자의 워크스페이스. 요청마다 이 값으로 DB 행 수준 보안 범위를 지정한다.
    workspaceId?: string;
    csrf?: string;
    issuedAt?: number;
    loginRequestId?: string;
  }
}
export class PgSessionStore extends session.Store {
  constructor(
    private readonly db: Db,
    private readonly audit: Audit,
  ) {
    super();
  }
  key(sid: string) {
    return createHash('sha256').update(sid).digest('hex');
  }
  get(sid: string, cb: (err?: any, data?: session.SessionData | null) => void) {
    this.db
      .tx(async (c) => {
        // 세션 표는 추측 불가능한 토큰 해시로만 찾으므로 RLS 없이 먼저 읽는다.
        const s = (
          await c.query('SELECT * FROM app.auth_sessions WHERE token_hash=$1', [this.key(sid)])
        ).rows[0];
        if (!s?.user_id) return s;
        // 계정 상태는 세션에 기록된 워크스페이스로 범위를 지정한 뒤 RLS 안에서 확인한다.
        // 워크스페이스가 없는 예전 세션은 계정이 보이지 않아 비활성으로 처리된다.
        await c.query("SELECT set_config('app.workspace_id', $1, true)", [s.workspace_id ?? '']);
        const a = (
          await c.query(
            'SELECT account_enabled,mapping_ready FROM app.account_access WHERE id=$1',
            [s.user_id],
          )
        ).rows[0];
        return {
          ...s,
          is_active: Boolean(a?.account_enabled && a?.mapping_ready),
          resp_active: Boolean(a?.account_enabled),
        };
      })
      .then(async (s) => {
        if (!s || s.revoked_at) return cb(null, null);
        if (
          s.idle_expires_at <= new Date() ||
          s.absolute_expires_at <= new Date() ||
          (s.user_id && (!s.is_active || !s.resp_active))
        ) {
          const result = await this.db.query(
            'UPDATE app.auth_sessions SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING user_id',
            [s.id],
          );
          if (result.rowCount && s.user_id)
            await this.audit.failure({
              userId: s.user_id,
              workspaceId: s.workspace_id ?? undefined,
              action: 'SESSION_EXPIRED',
              outcome: 'SUCCESS',
            });
          return cb(null, null);
        }
        cb(null, s.session_data);
      })
      .catch(cb);
  }
  // 세션과 로그인 감사 기록을 함께 커밋한다. loginRequestId는 일회성 표식으로 저장 JSON에서는 제거한다.
  // 로그인 세션은 세션 데이터의 워크스페이스로 트랜잭션 범위를 지정해 계정 확인·감사 기록이 같은 업체에 남게 한다.
  set(sid: string, data: session.SessionData, cb?: (err?: any) => void) {
    const loginId = data.loginRequestId;
    const persisted = { ...data };
    delete persisted.loginRequestId;
    const issued = data.issuedAt || Date.now();
    this.db
      .tx(async (c) => {
        const existing = await c.query(
          'SELECT revoked_at FROM app.auth_sessions WHERE token_hash=$1 FOR UPDATE',
          [this.key(sid)],
        );
        if (existing.rows[0]?.revoked_at) throw new Error('Session revoked');
        if (data.userId) {
          const user = await c.query(
            'SELECT u.id FROM app.users u JOIN app.responsibilities r ON r.id=u.resp_id JOIN app.account_access a ON a.id=u.id WHERE u.id=$1 AND a.account_enabled AND a.mapping_ready FOR SHARE OF u,r',
            [data.userId],
          );
          if (!user.rowCount) throw new Error('Inactive account');
        }
        await c.query(
          `INSERT INTO app.auth_sessions(id,token_hash,user_id,session_data,idle_expires_at,absolute_expires_at,workspace_id)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(token_hash) DO UPDATE SET session_data=EXCLUDED.session_data`,
          [
            randomUUID(),
            this.key(sid),
            data.userId || null,
            JSON.stringify(persisted),
            new Date(Math.min(Date.now() + settings.idleMs, issued + settings.absoluteMs)),
            new Date(issued + settings.absoluteMs),
            data.userId ? data.workspaceId || null : null,
          ],
        );
        if (loginId)
          await this.audit.write(
            { requestId: loginId, userId: data.userId, action: 'LOGIN', outcome: 'SUCCESS' },
            c,
          );
      }, data.workspaceId)
      .then(() => {
        delete data.loginRequestId;
        cb?.();
      })
      .catch((e) => cb?.(e));
  }
  destroy(sid: string, cb?: (err?: any) => void) {
    this.db
      .query('UPDATE app.auth_sessions SET revoked_at=now() WHERE token_hash=$1', [this.key(sid)])
      .then(() => cb?.())
      .catch((e) => cb?.(e));
  }
  // 자동 touch는 수명을 늘리지 않는다. 백그라운드 요청만으로 세션이 유지되는 것을 방지한다.
  touch(_sid: string, _data: session.SessionData, cb?: () => void) {
    cb?.();
  }
  // 사용자 활동도 절대 만료를 넘지 못하며 이미 만료·폐기된 세션은 되살리지 않는다.
  async activity(sid: string) {
    await this.db.query(
      `UPDATE app.auth_sessions SET last_activity_at=now(),idle_expires_at=LEAST(now()+interval '30 minutes',absolute_expires_at)
   WHERE token_hash=$1 AND revoked_at IS NULL AND idle_expires_at>now() AND absolute_expires_at>now()`,
      [this.key(sid)],
    );
  }
}
