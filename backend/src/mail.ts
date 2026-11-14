/**
 * 메일 발송. 업무 코드는 hold()로 암호화한 메일을 대기열(app.mail_outbox)에 넣기만 하고,
 * 이 파일의 발송기가 주기적으로 대기열을 읽어 SMTP(예: Gmail)로 보낸다.
 * - 대기열에 넣는 일은 계정 변경·요청 처리와 같은 트랜잭션이라, 업무가 롤백되면 메일도 함께 사라진다.
 * - 실제 발송은 커밋 뒤 따로 하므로 메일 서버가 느리거나 실패해도 요청 처리는 정상 완료된다.
 * - SMTP 설정(.env SMTP_HOST)이 없으면 보내지 않고 HELD로 남긴다(개발·테스트 기본값, mail-preview.cjs로 확인).
 * 관련 모듈: recovery.ts(계정 메일), requests.ts(업무 메일), notifier.ts(최종 실패 경보), 010·018 마이그레이션.
 */
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import nodemailer, { Transporter } from 'nodemailer';
import { PoolClient } from 'pg';
import { settings } from './config';
import { Db } from './db';
import { Notifier } from './notifier';
export type MailContent = { to: string; subject: string; text: string };
// 용도 문자열을 섞어 세션 서명 키를 암호화 키로 직접 재사용하지 않는다. 키 교체 시 보류 메일도 재발급한다.
const key = () =>
  createHash('sha256')
    .update('doneline-mail-outbox:' + settings.secret)
    .digest();
export function openMail(payload: string): MailContent {
  const [iv, tag, content] = payload.split('.').map((v) => Buffer.from(v, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(content), decipher.final()]).toString('utf8'));
}
// 발송 실패 후 다음 시도까지 기다릴 분. 네 번 미룬 뒤 다섯 번째도 실패하면 FAILED로 멈춘다.
const RETRY_MINUTES = [1, 5, 15, 60];
const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;
// 한 번 꺼낸 메일은 5분간 다른 발송기가 꺼내지 못하게 미뤄 둔다(서버가 발송 중 꺼지면 5분 뒤 다시 시도).
const LEASE_MINUTES = 5;

@Injectable()
export class Mail implements OnModuleDestroy {
  // SMTP 연결 설정. 설정이 없으면 null이며 발송기는 아무것도 하지 않는다.
  private readonly transport: Transporter | null = settings.smtp.host
    ? nodemailer.createTransport({
        host: settings.smtp.host,
        port: settings.smtp.port,
        // secure: 465는 처음부터 암호화 연결, 587은 평문으로 연결한 뒤 STARTTLS로 바꾼다.
        // requireTLS: 암호화로 바꾸지 못하면 보내지 않는다. 같은 PC 안의 메일 서버(테스트용)만 예외로 둔다(통신이 PC 밖으로 나가지 않음).
        secure: settings.smtp.port === 465,
        requireTLS:
          settings.smtp.port !== 465 &&
          !['127.0.0.1', '::1', 'localhost'].includes(settings.smtp.host),
        auth: settings.smtp.user
          ? { user: settings.smtp.user, pass: settings.smtp.pass }
          : undefined,
        // 메일 서버가 응답하지 않을 때 오래 붙잡지 않도록 연결·응답 대기를 제한한다(밀리초).
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 20000,
      })
    : null;
  private timer?: NodeJS.Timeout;
  // 이전 발송이 끝나기 전에 다음 주기가 와도 겹쳐 실행하지 않는다.
  private running = false;
  constructor(
    private readonly db: Db,
    private readonly notifier: Notifier,
  ) {}
  /** 실제 발송 여부. 화면 안내 문구(메일로 보냈습니다/링크를 전달해주세요)를 고르는 데 쓴다. */
  get enabled() {
    return Boolean(this.transport);
  }
  /**
   * 메일을 대기열에 넣는다. 호출자의 트랜잭션(c)으로 기록해 업무 변경과 함께 커밋·롤백되게 한다.
   * kind: ACCOUNT(계정 링크) 또는 REQUEST(고객 요청 업무 알림). minutes: 이 시간 안에 보내지 못하면 보내지 않는다.
   */
  async hold(
    c: PoolClient,
    userId: string,
    content: MailContent,
    options: { kind?: 'ACCOUNT' | 'REQUEST'; minutes?: number } = {},
  ) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key(), iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(content), 'utf8'),
      cipher.final(),
    ]);
    const payload = [iv, cipher.getAuthTag(), encrypted].map((v) => v.toString('base64')).join('.');
    await c.query(
      `INSERT INTO app.mail_outbox(user_id,payload,kind,expires_at) VALUES($1,$2,$3,now()+make_interval(mins=>$4))`,
      [userId, payload, options.kind || 'ACCOUNT', options.minutes ?? 30],
    );
  }
  /** 서버 시작 시 main.ts가 호출한다. 15초마다 대기열을 확인한다. 테스트는 start 없이 flush를 직접 부른다. */
  start() {
    if (!this.transport || this.timer) return;
    this.timer = setInterval(() => void this.flush(), 15000);
    // unref: 이 타이머만 남았다고 프로세스 종료를 막지 않게 한다.
    this.timer.unref();
    void this.flush();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.transport?.close();
  }
  /**
   * 보낼 차례가 된 메일을 보낸다. 반환값은 이번에 발송 완료한 수.
   * 순서: ① 워크스페이스 ID 조회(RLS 밖 함수) ② 워크스페이스별 짧은 트랜잭션에서 메일을 꺼내며 5분 뒤로 미룸(잠금은 바로 해제)
   *       ③ 트랜잭션 밖에서 SMTP 발송 ④ 결과 기록. SMTP를 기다리는 동안 DB 잠금을 쥐지 않아 사용자 저장이 막히지 않는다.
   */
  async flush(): Promise<number> {
    if (!this.transport || this.running) return 0;
    this.running = true;
    let sent = 0,
      failed = 0;
    try {
      const workspaces = (await this.db.query('SELECT app.mail_due_workspaces() AS id')).rows.map(
        (r) => String(r.id),
      );
      for (const workspaceId of workspaces) {
        // FOR UPDATE SKIP LOCKED: 다른 발송기가 잡고 있는 행은 기다리지 않고 건너뛴다.
        const batch = await this.db.tx(async (c) => {
          const rows = (
            await c.query(
              `SELECT id,payload,attempts FROM app.mail_outbox
               WHERE status='HELD' AND next_attempt_at<=now() AND expires_at>now()
               ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED`,
            )
          ).rows;
          if (rows.length)
            await c.query(
              'UPDATE app.mail_outbox SET next_attempt_at=now()+make_interval(mins=>$2) WHERE id=ANY($1)',
              [rows.map((r) => r.id), LEASE_MINUTES],
            );
          return rows;
        }, workspaceId);
        for (const row of batch) {
          const ok = await this.deliver(workspaceId, row);
          if (ok === true) sent++;
          else if (ok === 'FAILED') failed++;
        }
      }
    } catch {
      console.error('MAIL_FLUSH_FAILED');
    } finally {
      this.running = false;
    }
    if (failed)
      this.notifier.alert(
        'mail-failed',
        `메일 ${failed}건을 ${MAX_ATTEMPTS}회 시도했지만 보내지 못했습니다. .env의 SMTP 설정과 서버 로그(MAIL_SEND_FAILED)를 확인해주세요.`,
      );
    return sent;
  }
  /**
   * 메일 1건 발송과 결과 기록. 성공이면 true, 최종 실패면 'FAILED', 재시도 예정이면 false.
   * 상태 갱신은 status='HELD' 조건을 붙여, 발송 중 계정 변경으로 취소된 메일을 되살리지 않는다.
   */
  private async deliver(workspaceId: string, row: any): Promise<true | false | 'FAILED'> {
    try {
      const mail = openMail(row.payload);
      await this.transport!.sendMail({
        from: settings.smtp.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
      });
      // 보낸 뒤에는 링크·주소가 담긴 내용을 지워 DB에 개인정보를 남기지 않는다.
      await this.db.query(
        `UPDATE app.mail_outbox SET status='SENT',payload='',sent_at=now(),attempts=attempts+1,last_error=NULL
         WHERE id=$1 AND status='HELD'`,
        [row.id],
        workspaceId,
      );
      return true;
    } catch (e: any) {
      // 오류 코드만 남긴다(오류 문장에는 받는 주소가 섞일 수 있음).
      const code = String(e?.responseCode ? 'SMTP ' + e.responseCode : e?.code || 'UNKNOWN').slice(
        0,
        40,
      );
      console.error('MAIL_SEND_FAILED', code);
      const attempts = row.attempts + 1;
      // 5xx 응답(주소 없음 등)은 다시 보내도 같은 결과라 바로 중단한다. 그 밖(연결 실패·4xx)은 간격을 두고 재시도한다.
      const final = attempts >= MAX_ATTEMPTS || (e?.responseCode >= 500 && e?.responseCode < 600);
      await this.db
        .query(
          final
            ? `UPDATE app.mail_outbox SET status='FAILED',payload='',attempts=$2,last_error=$3 WHERE id=$1 AND status='HELD'`
            : `UPDATE app.mail_outbox SET attempts=$2,last_error=$3,next_attempt_at=now()+make_interval(mins=>$4) WHERE id=$1 AND status='HELD'`,
          final ? [row.id, attempts, code] : [row.id, attempts, code, RETRY_MINUTES[attempts - 1]],
          workspaceId,
        )
        .catch(() => console.error('MAIL_RESULT_SAVE_FAILED'));
      return final ? 'FAILED' : false;
    }
  }
}
