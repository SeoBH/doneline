/**
 * Doneline 운영팀에 보내는 알림(신규 업체 가입, 개선 요청, 서버 시작, 서버 오류, 메일 발송 실패 등).
 * 현재는 슬랙 Incoming Webhook 하나로 보낸다. 업체·고객에게 보내는 업무 알림과는 분리한다.
 * 관련 설정: config.ts의 slackWebhookUrl(.env의 SLACK_WEBHOOK_URL). 관련 모듈: errors.ts(서버 오류), mail.ts(발송 실패), main.ts(서버 시작).
 */
import { Injectable } from '@nestjs/common';
import { settings } from './config';

// 같은 경보를 다시 보내기까지 기다리는 시간(10분). 장애가 이어지는 동안 채널이 같은 메시지로 덮이지 않게 한다.
const ALERT_WINDOW_MS = 10 * 60 * 1000;

@Injectable()
export class Notifier {
  // 경보 종류(key)별 마지막 발송 시각과 그 뒤 생략한 횟수. 서버 메모리에만 두므로 재시작하면 초기화된다.
  private readonly recent = new Map<string, { at: number; skipped: number }>();
  /**
   * 운영 알림을 보낸다. 알림 실패가 가입·저장 같은 본 업무를 실패시키지 않도록 예외를 던지지 않고,
   * 응답을 기다리지 않아도 되게 호출자는 커밋이 끝난 뒤 void로 호출한다.
   * 메시지에는 비밀번호·토큰·연락처·메일 주소 같은 개인정보를 넣지 않는다(슬랙은 외부 서비스).
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
  /**
   * 반복될 수 있는 경보(서버 오류·메일 실패). 같은 key는 10분에 한 번만 보내고, 그사이 생략한 횟수를 다음 경보에 붙인다.
   * 결과를 기다리지 않는다(호출한 요청의 응답이 슬랙 때문에 늦어지지 않게).
   */
  alert(key: string, text: string) {
    const now = Date.now(),
      prev = this.recent.get(key);
    if (prev && now - prev.at < ALERT_WINDOW_MS) {
      prev.skipped++;
      return;
    }
    const extra = prev?.skipped ? ` (지난 경보 이후 같은 경보 ${prev.skipped}건 생략)` : '';
    this.recent.set(key, { at: now, skipped: 0 });
    void this.ops(text + extra);
  }
}
