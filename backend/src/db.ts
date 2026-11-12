/**
 * PostgreSQL 연결 풀과 트랜잭션 공통 처리. 관련 쿼리는 tx 콜백에 받은 연결로 실행해야 함께 커밋·롤백된다.
 * 연결 정보는 환경변수에서 읽으며 연결 수와 대기 시간을 제한한다.
 *
 * 워크스페이스 분리: DB의 행 수준 보안(RLS)은 트랜잭션 설정 app.workspace_id로 현재 워크스페이스를 판단한다.
 * 모든 SQL은 tx 또는 query를 거쳐 실행하며, 트랜잭션 시작 직후 그 값을 지정한다.
 * 지정이 없으면 RLS 대상 테이블이 비어 보이므로 실수로 다른 업체 데이터가 섞이지 않는다.
 * 관련 모듈: app.ts(요청별 컨텍스트 생성), security.ts·session-store.ts·auth.ts(워크스페이스 지정).
 */
import './config';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResult } from 'pg';

// AsyncLocalStorage는 한 HTTP 요청에서 이어지는 비동기 처리 전체가 같은 저장 공간을 보게 한다.
// 요청 시작 시 빈 객체를 만들고(app.ts), 로그인 확인 후 workspaceId를 채운다.
// 덕분에 서비스 함수마다 워크스페이스를 인자로 넘기지 않아도 tx가 현재 요청의 값을 읽는다.
export type DbContext = { workspaceId?: string };
export const dbContext = new AsyncLocalStorage<DbContext>();

/** 현재 요청의 워크스페이스를 지정한다. 요청 컨텍스트 밖에서 호출하면 설정 누락을 숨기지 않도록 오류를 낸다. */
export function useWorkspace(workspaceId: string) {
  const store = dbContext.getStore();
  if (!store) throw new Error('Database context is missing');
  store.workspaceId = String(workspaceId);
}

@Injectable()
// @Injectable은 NestJS가 이 클래스를 서비스로 주입할 수 있도록 메타데이터를 붙인다.
export class Db implements OnModuleDestroy {
  // private: 풀에 직접 쿼리하면 워크스페이스 지정을 건너뛰므로 외부에서는 tx/query만 사용한다.
  private readonly pool = new Pool({
    // 연결을 매번 새로 만들지 않고 최대 10개까지 재사용한다. 아래 시간 단위는 밀리초다.
    max: 10,
    // 연결 확보는 최대 5초 대기, 사용하지 않는 연결은 30초 후 정리, SQL은 10초 제한이다.
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 10000,
  });
  // 요청 밖에서 실행하는 초기화 스크립트·테스트 준비 코드 전용 기본값. HTTP 요청에는 적용하지 않는다.
  private scriptWorkspace?: string;
  constructor() {
    this.pool.on('error', () => console.error('PostgreSQL idle connection error'));
  }
  /**
   * 성공 시 커밋, 예외 시 롤백 후 오류를 전달한다. finally에서 연결을 반드시 풀로 반환한다.
   * workspaceId를 생략하면 요청 컨텍스트의 값을 쓰고, 요청 밖이면 스크립트 기본값을 쓴다.
   * 요청 안에서 아직 로그인 전이면 값이 없으므로 RLS 대상 테이블은 조회되지 않는다.
   */
  async tx<T>(fn: (client: PoolClient) => Promise<T>, workspaceId?: string): Promise<T> {
    // <T>는 호출자가 반환하는 결과 타입을 그대로 보존한다.
    return this.run('BEGIN', fn, workspaceId);
  }
  /**
   * 읽기 전용 스냅샷 트랜잭션. 여러 SELECT가 모두 같은 시점의 데이터를 보게 한다(권한 캐시·메뉴 트리).
   * 격리 수준은 트랜잭션의 첫 쿼리 전에 정해야 하므로 워크스페이스 지정보다 먼저 BEGIN 문에 포함한다.
   */
  snapshot<T>(fn: (client: PoolClient) => Promise<T>, workspaceId?: string): Promise<T> {
    return this.run('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', fn, workspaceId);
  }
  private async run<T>(
    begin: string,
    fn: (client: PoolClient) => Promise<T>,
    workspaceId?: string,
  ): Promise<T> {
    const store = dbContext.getStore();
    const workspace = workspaceId ?? (store ? store.workspaceId : this.scriptWorkspace);
    const c = await this.pool.connect();
    try {
      await c.query(begin);
      // set_config의 세 번째 인자 true는 "이 트랜잭션에서만" 유효하다는 뜻이다.
      // 커밋·롤백 후 풀에 돌아간 연결을 다음 요청이 써도 이전 업체 값이 남지 않는다.
      if (workspace) await c.query("SELECT set_config('app.workspace_id', $1, true)", [workspace]);
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
  /** SQL 한 문장을 워크스페이스가 지정된 짧은 트랜잭션으로 실행한다. 여러 문장을 묶어야 하면 tx를 쓴다. */
  query(text: string, values?: unknown[], workspaceId?: string): Promise<QueryResult> {
    return this.tx((c) => c.query(text, values), workspaceId);
  }
  /** 초기화 스크립트·테스트처럼 HTTP 요청 밖에서 실행할 때 쓸 워크스페이스를 정한다. */
  useScriptWorkspace(workspaceId: string) {
    this.scriptWorkspace = String(workspaceId);
  }
  /** 운영 워크스페이스 ID. RLS 밖에서 ID만 돌려주는 DB 함수로 조회한다. */
  async platformWorkspaceId(): Promise<string> {
    return (await this.query('SELECT app.platform_workspace_id() AS id')).rows[0].id;
  }
  async onModuleDestroy() {
    await this.pool.end();
  }
}
