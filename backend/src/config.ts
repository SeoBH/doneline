/**
 * 루트 .env에서 설정을 읽는다.
 * 기존 환경변수는 유지하므로 테스트에서 별도 DB를 지정할 수 있다.
 * 시작 시 세션 서명 키와 운영 HTTPS 출처를 검증한다.
 */
import { config } from 'dotenv';
import { resolve } from 'node:path';
config({ path: resolve(__dirname, '../../.env'), quiet: true });
const secret = process.env.SESSION_SECRET;
if (!secret || secret.length < 32)
  throw new Error('SESSION_SECRET must contain at least 32 characters');
export const settings = {
  secret,
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '127.0.0.1',
  origin: process.env.APP_ORIGIN || 'http://127.0.0.1:3000',
  production: process.env.NODE_ENV === 'production',
  idleMs: 30 * 60 * 1000,
  absoluteMs: 8 * 60 * 60 * 1000,
  // 운영 알림용 슬랙 Incoming Webhook 주소. 비어 있으면 알림을 보내지 않는다(테스트는 빈 값으로 실행).
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || '',
  // 외부 데모처럼 Cloudflare 터널·Pages 프록시 뒤에서 실행할 때만 '1'. 프록시가 보낸 X-Forwarded-* 헤더로
  // 실제 접속 IP(로그인 시도 제한)와 HTTPS 여부(보안 쿠키 발급)를 판단한다. 서버가 127.0.0.1에만 열려 있어
  // 프록시 외에는 직접 접속할 수 없을 때만 켠다(아무나 헤더를 꾸며 IP 제한을 피하지 못하게).
  trustProxy: process.env.TRUST_PROXY === '1',
};
if (settings.production && !settings.origin.startsWith('https://'))
  throw new Error('Production requires HTTPS origin');
// 프록시 신뢰는 외부에서 서버에 직접 접속할 수 없을 때만 안전하므로 로컬 주소에서만 허용한다.
if (settings.trustProxy && !['127.0.0.1', '::1', 'localhost'].includes(settings.host))
  throw new Error('TRUST_PROXY=1 requires HOST to be a loopback address');
// 오타나 다른 주소로 내부 정보를 보내지 않도록 슬랙 Webhook 주소 형식만 허용한다.
if (settings.slackWebhookUrl && !settings.slackWebhookUrl.startsWith('https://hooks.slack.com/'))
  throw new Error('SLACK_WEBHOOK_URL must start with https://hooks.slack.com/');
