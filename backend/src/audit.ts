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
};
@Injectable()
export class Audit {
  constructor(private readonly db: Db) {}
  async write(e: AuditEvent, c?: PoolClient) {
    const id = randomUUID();
    await (c || this.db.pool).query(
      "INSERT INTO audit.audit_events(event_id,operation_id,request_id,source,user_id,resp_id,menu_id,screen_id,action,phase,outcome,error_code) VALUES($1,$1,$2,'SERVER',$3,$4,$5,$6,$7,'END',$8,$9)",
      [
        id,
        e.requestId || null,
        e.userId || null,
        e.respId || null,
        e.menuId || null,
        e.screenId || null,
        e.action,
        e.outcome,
        e.code || null,
      ],
    );
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
