/**
 * 예외를 공통 HTTP 응답으로 변환한다.
 * 내부 오류는 일반 메시지로 숨기고 요청 ID로 추적한다.
 * 등록 API의 행별 오류는 rowErrors로 전달한다.
 * 500번대(예상하지 못한 서버 오류)는 운영 슬랙에도 알린다(notifier.ts, 같은 화면 오류는 10분에 한 번).
 */
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Injectable } from '@nestjs/common';
import { Response } from 'express';
import { Audit } from './audit';
import { Notifier } from './notifier';
import { AppRequest } from './security';
@Catch()
@Injectable()
export class ErrorFilter implements ExceptionFilter {
  constructor(
    private readonly audit: Audit,
    private readonly notifier: Notifier,
  ) {}
  async catch(error: unknown, host: ArgumentsHost) {
    const req = host.switchToHttp().getRequest<AppRequest>(),
      res = host.switchToHttp().getResponse<Response>();
    const status = error instanceof HttpException ? error.getStatus() : 500;
    const message =
      error instanceof HttpException ? error.message : '서버 처리 중 오류가 발생했습니다.';
    const action = req.route?.path ? req.method + ' ' + req.route.path : 'HTTP_REQUEST';
    // 슬랙에는 요청 경로 형식(:id 같은 자리표시 그대로)과 요청 ID만 보낸다. 사용자·입력값·오류 문장은 넣지 않는다.
    // 자세한 내용은 요청 ID로 서버 로그·감사 기록에서 찾는다.
    if (status >= 500) {
      // 서버 로그에는 요청 ID와 오류 위치(stack)를 남겨 슬랙 경보에서 원인을 찾아갈 수 있게 한다.
      // DB 오류의 detail(입력값이 담길 수 있음)은 남기지 않는다.
      console.error(
        'SERVER_ERROR',
        req.requestId,
        (error as any)?.code || '',
        (error as Error)?.stack || String(error),
      );
      this.notifier.alert(
        'error:' + action,
        `서버 오류가 발생했습니다: ${action} (요청 ID ${req.requestId}). 서버 로그와 감사 기록을 확인해주세요.`,
      );
    }
    await this.audit.failure({
      requestId: req.requestId,
      userId: req.actor?.id || req.session?.userId,
      action,
      outcome: status >= 500 ? 'ERROR' : 'FAILURE',
      code: String(status),
    });
    const detail = error instanceof HttpException ? error.getResponse() : null;
    const rowErrors =
      typeof detail === 'object' && detail && 'rowErrors' in detail
        ? (detail as any).rowErrors
        : undefined;
    if (!res.headersSent) res.status(status).json({ message, requestId: req.requestId, rowErrors });
  }
}
