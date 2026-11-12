/** 로컬 개발 전용 메일 미리보기. 공개 API 없이 명시한 메일 하나만 확인하며 운영 환경에서는 차단한다. */
// 모든 워크스페이스의 보류 메일을 확인하는 로컬 도구다. 앱 계정은 행 수준 보안 때문에 다른 업체의 메일을 볼 수 없으므로
// 소유자 권한으로 RLS를 적용받지 않는 DB 관리 계정(.env.db-admin)으로 접속한다. 이 파일은 개발 PC에만 둔다.
require('dotenv').config({ path: require('node:path').resolve(__dirname, '../.env.db-admin'), quiet: true });
const { Db } = require('./dist/db');
const { settings } = require('./dist/config');
const { openMail } = require('./dist/mail');
(async () => {
  if (settings.production) throw Error('운영 환경에서는 미리보기를 사용할 수 없습니다.');
  const db = new Db();
  try {
    const id = process.argv[2];
    if (!id) {
      const result = await db.query(
        "SELECT m.id,u.login_id,m.created_at,m.expires_at FROM app.mail_outbox m JOIN app.users u ON u.id=m.user_id WHERE m.status='HELD' AND m.expires_at>now() ORDER BY m.id DESC LIMIT 20",
      );
      console.table(result.rows);
      console.log(
        'node backend/mail-preview.cjs <메일 ID> 로 한 건을 확인합니다. 링크를 공유 로그에 남기지 마세요.',
      );
    } else {
      if (!/^\d+$/.test(id)) throw Error('메일 ID는 숫자입니다.');
      const { rows } = await db.query(
        "SELECT payload FROM app.mail_outbox WHERE id=$1 AND status='HELD' AND expires_at>now()",
        [id],
      );
      if (!rows[0]) throw Error('유효한 보류 메일이 없습니다. 다시 발급해주세요.');
      const mail = openMail(rows[0].payload);
      console.log(`수신: ${mail.to}\n제목: ${mail.subject}\n${mail.text}`);
    }
  } finally {
    await db.onModuleDestroy();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
