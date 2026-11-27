/**
 * 업무 결과 감사 기록. 연결을 전달하면 업무 변경과 같은 트랜잭션에 참여한다.
 * 실패 기록은 DB 장애 시 JSONL로 대체하며 호출자는 비밀값·요청 본문·원본 예외를 전달하지 않아야 한다.
 */
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PoolClient } from 'pg';
import { Db } from './db';
export type AuditEvent = {
  requestId?: string;
  userId?: string;
  respId?: string;
  menuId?: string;
  screenId?: string;
  action: string;
  outcome: 'SUCCESS' | 'FAILURE' | 'ERROR' | 'CANCELLED';
  code?: string;
  // 요청 컨텍스트와 다른 워크스페이스로 기록해야 할 때만 지정한다(예: 만료 세션 정리).
  workspaceId?: string;
};
@Injectable()
export class Audit {
  constructor(private readonly db: Db) {}
  private timer?: NodeJS.Timeout;
  /**
   * 1년 보관 기간이 지난 감사 기록 자동 파기(개인정보처리방침 '보유 기간', 026 마이그레이션).
   * main.ts가 서버 시작 때 부른다. 시작 직후 한 번, 이후 하루마다. 실패해도 서버는 계속 돌고 다음 날 다시 시도한다.
   * 함수 한 번에 5,000건까지만 지우므로, 밀린 양이 많으면 한 실행 안에서 0건이 나올 때까지(최대 20번) 반복한다.
   */
  startRetention() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.purgeExpired(), 24 * 60 * 60 * 1000);
    this.timer.unref(); // 이 타이머만 남았다고 프로세스 종료를 막지 않게 한다.
    void this.purgeExpired();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  /** 지운 감사 이벤트 수를 돌려준다. 테스트는 이 함수를 직접 부른다. */
  async purgeExpired(): Promise<number> {
    let total = 0;
    try {
      for (let i = 0; i < 20; i++) {
        const n = Number((await this.db.query('SELECT audit.purge_expired() AS n')).rows[0].n);
        total += n;
        if (n < 5000) break;
      }
    } catch {
      console.error('AUDIT_RETENTION_FAILED');
    }
    return total;
  }
  async write(e: AuditEvent, c?: PoolClient) {
    const id = randomUUID();
    // workspace_id는 DB 기본값으로 현재 트랜잭션의 워크스페이스가 들어간다(모르면 NULL).
    const sql =
      "INSERT INTO audit.audit_events(event_id,operation_id,request_id,source,user_id,resp_id,menu_id,screen_id,action,phase,outcome,error_code) VALUES($1,$1,$2,'SERVER',$3,$4,$5,$6,$7,'END',$8,$9)";
    const values = [
      id,
      e.requestId || null,
      e.userId || null,
      e.respId || null,
      e.menuId || null,
      e.screenId || null,
      e.action,
      e.outcome,
      e.code || null,
    ];
    // 연결을 받으면 호출자의 트랜잭션에 참여하고, 없으면 짧은 별도 트랜잭션으로 기록한다.
    if (c) await c.query(sql, values);
    else await this.db.query(sql, values, e.workspaceId);
    return id;
  }
  async failure(e: AuditEvent) {
    try {
      await this.write(e);
    } catch {
      // Allowlisted metadata only; never serialize request bodies or raw exceptions.
      const dir = resolve(__dirname, '../../runtime');
      try {
        await mkdir(dir, { recursive: true });
        await appendFile(
          resolve(dir, 'audit-fallback.jsonl'),
          JSON.stringify({ eventId: randomUUID(), at: new Date().toISOString(), ...e }) + '\n',
        );
      } catch {
        console.error('AUDIT_STORAGE_UNAVAILABLE');
      }
    }
  }
}
