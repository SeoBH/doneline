/**
 * Doneline 운영팀에 보내는 알림(신규 업체 가입, 결제·계정 조치 필요 등).
 * 현재는 슬랙 Incoming Webhook 하나로 보낸다. 업체·고객에게 보내는 업무 알림과는 분리한다.
 * 관련 설정: config.ts의 slackWebhookUrl(.env의 SLACK_WEBHOOK_URL).
 */
import { Injectable } from '@nestjs/common';
import { settings } from './config';

@Injectable()
export class Notifier {
  /**
   * 운영 알림을 보낸다. 알림 실패가 가입·저장 같은 본 업무를 실패시키지 않도록 예외를 던지지 않고,
   * 응답을 기다리지 않아도 되게 호출자는 커밋이 끝난 뒤 void로 호출한다.
   * 메시지에는 비밀번호·토큰·연락처 같은 개인정보를 넣지 않는다(슬랙은 외부 서비스).
   */
  async ops(text: string): Promise<void> {
    if (!settings.slackWebhookUrl) return;
    try {
      // AbortSignal.timeout: 5초 안에 응답이 없으면 요청을 끊어 서버 자원을 붙잡지 않는다.
      const res = await fetch(settings.slackWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) console.error('OPS_NOTIFY_FAILED', res.status);
    } catch {
      console.error('OPS_NOTIFY_UNAVAILABLE');
    }
  }
}
