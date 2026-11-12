/**
 * 개발 서버의 /api 요청을 백엔드 3100 포트로 전달한다. 운영에서는 NestJS가 프런트 빌드 파일을 제공한다.
 */
import { defineConfig } from 'vite';
export default defineConfig({ server: { proxy: { '/api': 'http://127.0.0.1:3100' } } });
