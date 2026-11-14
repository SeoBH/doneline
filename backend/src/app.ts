/**
 * 애플리케이션 조립 지점. 컨트롤러·서비스 등록 후 보안 헤더, 요청 ID, DB 세션, DTO 검증, 공통 오류 응답을 구성한다.
 * 현재 등록 기능은 RegistrationController를 사용한다.
 */
import 'reflect-metadata';
import { Module, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import session from 'express-session';
import helmet from 'helmet';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { settings } from './config';
import { Permissions } from './permissions';
import { Db, dbContext } from './db';
import { RegistrationController, RegistrationService } from './registration';
import { Audit } from './audit';
import { PgSessionStore } from './session-store';
import { SecurityGuard } from './security';
import { ErrorFilter } from './errors';
import { AuthController, AuthService } from './auth';
import { NavigationController, NavigationService } from './navigation';
import { Accounts, AccountsController } from './accounts';
import { Recovery, RecoveryController } from './recovery';
import { Mail } from './mail';
import { validationError } from './validation';
import { Notifier } from './notifier';
import { Workspaces, WorkspacesController } from './workspaces';
import { Requests, RequestsController } from './requests';
import { Sla, SlaController } from './sla';
import { Reports, ReportsController } from './reports';
import { Feedback, FeedbackController } from './feedback';
@Module({
  controllers: [
    AuthController,
    NavigationController,
    RegistrationController,
    AccountsController,
    RecoveryController,
    WorkspacesController,
    RequestsController,
    SlaController,
    ReportsController,
    FeedbackController,
  ],
  providers: [
    Db,
    Recovery,
    Mail,
    Notifier,
    Workspaces,
    Requests,
    Sla,
    Reports,
    Feedback,
    Accounts,
    Audit,
    RegistrationService,
    Permissions,
    AuthService,
    NavigationService,
    ErrorFilter,
    {
      provide: PgSessionStore,
      useFactory: (db: Db, audit: Audit) => new PgSessionStore(db, audit),
      inject: [Db, Audit],
    },
    { provide: APP_GUARD, useClass: SecurityGuard },
  ],
})
export class AppModule {}
export async function createApp() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn'],
  });
  // 숫자 n: 오른쪽부터 n개의 프록시만 신뢰한다(그보다 앞의 X-Forwarded-For 값은 꾸며낼 수 있으므로 무시).
  if (settings.trustProxy) app.set('trust proxy', settings.trustProxy);
  // Pages 중계 모드(운영 + PROXY_SECRET). 화면은 Cloudflare Pages가 주고 API만 중계 함수를 거쳐 들어온다.
  // ① 비밀 표식이 맞지 않는 요청(ts.net 직접 접속 등)은 거절한다.
  // ② 중계를 두 번 거치면(Pages → Tailscale) X-Forwarded-For로는 실제 접속자를 알 수 없으므로,
  //    표식이 맞을 때만 중계 함수가 알려 준 접속자 IP를 req.ip로 쓴다(로그인·가입 시도 제한의 기준).
  if (settings.production && settings.proxySecret) {
    const expected = createHash('sha256').update(settings.proxySecret).digest();
    app.use((req: any, res: any, next: any) => {
      // 같은 길이의 해시끼리 비교해 글자 수나 비교 시간으로 값을 추측할 수 없게 한다.
      const given = createHash('sha256')
        .update(String(req.get('x-doneline-proxy') || ''))
        .digest();
      if (!timingSafeEqual(given, expected))
        return res.status(403).json({ message: '허용되지 않은 접속 경로입니다.' });
      const ip = String(req.get('x-doneline-client-ip') || '');
      // Object.defineProperty: Express가 계산하는 req.ip 대신 이 요청에서만 중계 함수가 알려 준 값을 쓰게 한다.
      if (isIP(ip)) Object.defineProperty(req, 'ip', { value: ip, configurable: true });
      next();
    });
  }
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'upgrade-insecure-requests': settings.production ? [] : null,
          // blob: 화면이 권한 머리글을 붙여 받아 둔 첨부 이미지(메모리 속 임시 주소)를 본문에 표시하기 위해 허용한다.
          // 외부 사이트 이미지는 여전히 막힌다. 바꾸면 deploy/pages/_headers도 같은 값으로 맞춘다.
          'img-src': ["'self'", 'data:', 'blob:'],
        },
      },
    }),
  );
  app.use((req: any, res: any, next: any) => {
    req.requestId = randomUUID();
    res.setHeader('X-Request-ID', req.requestId);
    res.setHeader('Cache-Control', 'no-store');
    // 요청마다 빈 DB 컨텍스트를 만든다. 로그인 확인 뒤 워크스페이스가 채워지며(security.ts),
    // 그 전의 DB 작업은 워크스페이스 없이 실행되어 업체별 데이터에 접근하지 못한다.
    dbContext.run({}, next);
  });
  // 쿠키는 세션 식별자를 보관하고 본문·만료·폐기는 PgSessionStore가 DB에서 관리한다.
  const sessionMiddleware = session({
    name: 'doneline.sid',
    secret: settings.secret,
    store: app.get(PgSessionStore),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: settings.production,
      maxAge: settings.absoluteMs,
      path: '/',
    },
  });
  app.use((req: any, res: any, next: any) =>
    sessionMiddleware(req, res, (error?: any) => {
      if (!error) return next();
      void app
        .get(Audit)
        .failure({
          requestId: req.requestId,
          action: 'SESSION_LOAD',
          outcome: 'ERROR',
          code: 'SESSION_STORAGE_UNAVAILABLE',
        })
        .finally(() =>
          res
            .status(503)
            .json({ message: '인증 저장소에 연결할 수 없습니다.', requestId: req.requestId }),
        );
    }),
  );
  // DTO에 선언되지 않은 입력을 거절하고 검증된 요청만 컨트롤러에 전달한다.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      // 형식 오류를 어느 칸이 틀렸는지 알 수 있는 한국어 문장으로 응답한다(validation.ts).
      exceptionFactory: validationError,
    }),
  );
  app.useGlobalFilters(app.get(ErrorFilter));
  app.useStaticAssets(join(__dirname, '../../frontend/dist'));
  app.enableShutdownHooks();
  await app.init();
  return app;
}
