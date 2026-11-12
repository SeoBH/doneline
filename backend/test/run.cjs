/**
 * 현재 인증·등록 통합 테스트 실행기. PGDATABASE를 격리 테스트 DB로 고정하고 공유 제한 카운터 간 간섭을 줄이도록 파일을 순차 실행한다.
 * 자식 종료 코드를 그대로 전달한다.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const result = spawnSync(
  process.execPath,
  [
    '--test',
    '--test-concurrency=1',
    path.join(__dirname, 'auth.test.cjs'),
    path.join(__dirname, 'registration.test.cjs'),
    path.join(__dirname, 'accounts.test.cjs'),
    path.join(__dirname, 'recovery.test.cjs'),
    path.join(__dirname, 'workspace.test.cjs'),
    path.join(__dirname, 'requests.test.cjs'),
  ],
  // SLACK_WEBHOOK_URL을 빈 값으로 고정해 테스트 중 실제 슬랙 알림이 나가지 않게 한다(.env보다 우선).
  { stdio: 'inherit', env: { ...process.env, PGDATABASE: 'doneline_test', SLACK_WEBHOOK_URL: '' } },
);
process.exitCode = result.status ?? 1;
