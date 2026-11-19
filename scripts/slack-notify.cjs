/**
 * 팀 리더(Claude)·운영 스크립트가 슬랙 #doneline-알림에 '봇'으로 메시지를 보낸다.
 * Claude 슬랙 연결로 올리면 CEO 본인 계정 이름으로 게시돼 알림이 울리지 않으므로(내가 쓴 글은 알림 없음),
 * 앱 운영 알림과 같은 Incoming Webhook(.env SLACK_WEBHOOK_URL, backend/src/notifier.ts와 같은 값)을 쓴다.
 *
 * 사용: node scripts/slack-notify.cjs <메시지 파일 경로>   (파일 내용 = 슬랙 mrkdwn 문장)
 *       또는 표준 입력으로 메시지를 넘긴다.
 * 부수 효과: 슬랙 채널에 메시지 1건 게시. 웹훅 주소는 비밀값이라 출력하지 않는다.
 */
const fs = require('node:fs');
const path = require('node:path');
// backend의 dotenv를 빌려 쓴다(루트에는 node_modules가 없다). .env 값을 이 프로세스 안에서만 읽는다.
const dotenv = require(path.join(__dirname, '../backend/node_modules/dotenv'));
const env = dotenv.parse(fs.readFileSync(path.join(__dirname, '../.env')));
const url = env.SLACK_WEBHOOK_URL || '';
// 오타나 다른 주소로 내용을 보내지 않도록 슬랙 웹훅 형식만 허용한다(config.ts와 같은 검사).
if (!url.startsWith('https://hooks.slack.com/')) {
  console.error('SLACK_WEBHOOK_URL이 비어 있거나 슬랙 웹훅 형식이 아닙니다.');
  process.exit(1);
}
const file = process.argv[2];
const text = (file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8')).trim();
if (!text) {
  console.error('보낼 메시지가 비어 있습니다.');
  process.exit(1);
}
fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text }),
}).then(
  async (res) => {
    // 슬랙은 성공하면 200과 'ok'를 돌려준다. 실패 문장(예: no_service, channel_not_found)만 보여 준다.
    console.log(res.ok ? '보냄' : `실패: ${res.status} ${await res.text()}`);
    process.exit(res.ok ? 0 : 1);
  },
  (e) => {
    console.error('실패:', e.message);
    process.exit(1);
  },
);
