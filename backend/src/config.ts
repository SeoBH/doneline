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
  // 서버 앞에 있는 프록시 수(0=없음). Tailscale Funnel·클라우드 로드밸런서 뒤에서 실행할 때 1 이상으로 둔다.
  // 그 수만큼만 X-Forwarded-* 헤더를 믿어 실제 접속 IP(로그인 시도 제한)와 HTTPS 여부(보안 쿠키)를 판단한다.
  trustProxy: Number(process.env.TRUST_PROXY || 0),
  // 서버가 프록시를 거쳐서만 접속 가능한 환경(컨테이너·사설망)임을 운영자가 확인했다는 표시. 아래 검사 참고.
  proxyOnlyIngress: process.env.PROXY_ONLY_INGRESS === '1',
};
if (settings.production && !settings.origin.startsWith('https://'))
  throw new Error('Production requires HTTPS origin');
if (!Number.isInteger(settings.trustProxy) || settings.trustProxy < 0 || settings.trustProxy > 5)
  throw new Error('TRUST_PROXY must be an integer between 0 and 5');
// 프록시를 우회해 서버에 직접 접속할 수 있으면 누구나 헤더를 꾸며 IP 제한을 피할 수 있다.
// 그래서 로컬 주소에서만 열려 있거나(데모), 프록시 경유만 가능하다고 명시한 경우(클라우드)에만 허용한다.
if (
  settings.trustProxy &&
  !settings.proxyOnlyIngress &&
  !['127.0.0.1', '::1', 'localhost'].includes(settings.host)
)
  throw new Error('TRUST_PROXY requires a loopback HOST or PROXY_ONLY_INGRESS=1');
// 오타나 다른 주소로 내부 정보를 보내지 않도록 슬랙 Webhook 주소 형식만 허용한다.
if (settings.slackWebhookUrl && !settings.slackWebhookUrl.startsWith('https://hooks.slack.com/'))
  throw new Error('SLACK_WEBHOOK_URL must start with https://hooks.slack.com/');
