/**
 * 백엔드 진입점. 공통 앱 초기화 후 설정된 주소와 포트에서 HTTP 요청을 받는다.
 * 요청을 받기 시작하면 메일 발송기(mail.ts)를 켜고, 운영 슬랙에 서버 시작을 알린다
 * (서버 PC가 재부팅·재시작된 것을 알 수 있게). 테스트는 createApp만 쓰므로 둘 다 실행되지 않는다.
 */
import { createApp } from './app';
import { settings } from './config';
import { Mail } from './mail';
import { Notifier } from './notifier';
createApp()
  .then(async (app) => {
    await app.listen(settings.port, settings.host);
    console.log('Doneline: ' + settings.origin);
    const mail = app.get(Mail);
    mail.start();
    void app
      .get(Notifier)
      .ops(
        `Doneline 서버가 시작되었습니다: ${settings.origin} (메일 발송 ${mail.enabled ? '켜짐' : '꺼짐'})`,
      );
  })
  .catch(() => {
    console.error('Backend startup failed. Check database and environment settings.');
    process.exitCode = 1;
  });
