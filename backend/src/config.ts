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
};
if (settings.production && !settings.origin.startsWith('https://'))
  throw new Error('Production requires HTTPS origin');
