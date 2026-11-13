/**
 * DB 마이그레이션 자동 적용. database/의 번호순 SQL(001_*.sql …) 중 아직 적용하지 않은 것만 순서대로 실행하고,
 * 마지막에 grant-app.sql로 앱 계정(doneline_app) 권한을 다시 맞춘다.
 * 적용 여부는 public.schema_migrations 표의 version(파일명에서 .sql을 뺀 값)으로 판단한다. 각 SQL 파일이
 * 스스로 BEGIN/COMMIT과 version 기록을 포함하므로, 파일 하나가 실패하면 그 파일만 롤백되고 즉시 멈춘다.
 * 실행 계정: 표를 만들고 바꿀 수 있는 DB 관리 계정(소유자). 앱 계정으로 실행하지 않는다.
 * 사용: 로컬은 `node backend/migrate.cjs` (루트 .env.db-admin의 PG* 값 사용), CI·서버는 PG* 환경변수를 직접 지정.
 *       --dry-run: 적용할 목록만 출력하고 실행하지 않는다.
 */
const fs = require('node:fs');
const path = require('node:path');
// 환경변수가 이미 있으면 그대로 쓰고(CI·서버), 없을 때만 로컬 관리 계정 파일에서 읽는다.
require('dotenv').config({ path: path.resolve(__dirname, '../.env.db-admin'), quiet: true });
const { Client } = require('pg');

const dir = path.resolve(__dirname, '../database');
const dryRun = process.argv.includes('--dry-run');

(async () => {
  const client = new Client();
  await client.connect();
  try {
    // 001 이전의 빈 DB에는 기록 표가 없으므로, 없으면 "아무것도 적용 안 됨"으로 본다.
    const exists = (await client.query("SELECT to_regclass('public.schema_migrations') AS t"))
      .rows[0].t;
    const applied = new Set(
      exists
        ? (await client.query('SELECT version FROM public.schema_migrations')).rows.map(
            (r) => r.version,
          )
        : [],
    );
    // 파일명이 세 자리 번호로 시작하는 SQL만 대상으로 하고 번호순으로 정렬한다.
    const pending = fs
      .readdirSync(dir)
      .filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f))
      .sort()
      .filter((f) => !applied.has(f.replace(/\.sql$/, '')));
    console.log(`DB ${client.database}: 적용됨 ${applied.size}개, 적용할 것 ${pending.length}개`);
    for (const file of pending) {
      console.log((dryRun ? '[미리보기] ' : '적용: ') + file);
      if (!dryRun) await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
    }
    if (!dryRun) {
      // 권한 파일은 여러 번 실행해도 결과가 같다. 새 표가 생겼을 수 있으므로 매번 다시 맞춘다.
      await client.query(fs.readFileSync(path.join(dir, 'grant-app.sql'), 'utf8'));
      console.log('앱 계정 권한을 맞췄습니다.');
    }
  } finally {
    await client.end();
  }
})().catch((e) => {
  // 어떤 파일에서 실패했는지는 위의 "적용:" 줄로 알 수 있다. 비밀번호 등 접속 정보는 출력하지 않는다.
  console.error('마이그레이션 실패:', e.message);
  process.exitCode = 1;
});
