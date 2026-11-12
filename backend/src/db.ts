/**
 * PostgreSQL 연결 풀과 트랜잭션 공통 처리. 관련 쿼리는 tx 콜백에 받은 연결로 실행해야 함께 커밋·롤백된다.
 * 연결 정보는 환경변수에서 읽으며 연결 수와 대기 시간을 제한한다.
 */
import './config';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
@Injectable()
// @Injectable은 NestJS가 이 클래스를 서비스로 주입할 수 있도록 메타데이터를 붙인다.
export class Db implements OnModuleDestroy {
  readonly pool = new Pool({
    // 연결을 매번 새로 만들지 않고 최대 10개까지 재사용한다. 아래 시간 단위는 밀리초다.
    max: 10,
    // 연결 확보는 최대 5초 대기, 사용하지 않는 연결은 30초 후 정리, SQL은 10초 제한이다.
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 10000,
  });
  constructor() {
    this.pool.on('error', () => console.error('PostgreSQL idle connection error'));
  }
  // 성공 시 커밋, 예외 시 롤백 후 오류를 전달한다. finally에서 연결을 반드시 풀로 반환한다.
  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    // <T>는 호출자가 반환하는 결과 타입을 그대로 보존한다.
    // fn은 같은 DB 연결을 받아 업무 SQL을 실행하는 함수이며 await로 완료를 기다린다.
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async onModuleDestroy() {
    await this.pool.end();
  }
}
