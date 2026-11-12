/**
 * 백엔드 진입점. 공통 앱 초기화 후 설정된 주소와 포트에서 HTTP 요청을 받는다.
 */
import { createApp } from './app';
import { settings } from './config';
createApp()
  .then((app) => app.listen(settings.port, settings.host))
  .then(() => console.log('Doneline: ' + settings.origin))
  .catch(() => {
    console.error('Backend startup failed. Check database and environment settings.');
    process.exitCode = 1;
  });
