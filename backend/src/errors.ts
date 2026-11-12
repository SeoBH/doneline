/**
 * 예외를 공통 HTTP 응답으로 변환한다.
 * 내부 오류는 일반 메시지로 숨기고 요청 ID로 추적한다.
 * 등록 API의 행별 오류는 rowErrors로 전달한다.
 */
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Injectable } from '@nestjs/common';
import { Response } from 'express';
import { Audit } from './audit';
import { AppRequest } from './security';
@Catch()
@Injectable()
export class ErrorFilter implements ExceptionFilter {
  constructor(private readonly audit: Audit) {}
  async catch(error: unknown, host: ArgumentsHost) {
    const req = host.switchToHttp().getRequest<AppRequest>(),
      res = host.switchToHttp().getResponse<Response>();
    const status = error instanceof HttpException ? error.getStatus() : 500;
    const message =
      error instanceof HttpException ? error.message : '서버 처리 중 오류가 발생했습니다.';
    await this.audit.failure({
      requestId: req.requestId,
      userId: req.actor?.id || req.session?.userId,
      action: req.route?.path ? req.method + ' ' + req.route.path : 'HTTP_REQUEST',
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
