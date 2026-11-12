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
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { settings } from './config';
import { Permissions } from './permissions';
import { Db } from './db';
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
@Module({
  controllers: [
    AuthController,
    NavigationController,
    RegistrationController,
    AccountsController,
    RecoveryController,
  ],
  providers: [
    Db,
    Recovery,
    Mail,
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
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { 'upgrade-insecure-requests': settings.production ? [] : null },
      },
    }),
  );
  app.use((req: any, res: any, next: any) => {
    req.requestId = randomUUID();
    res.setHeader('X-Request-ID', req.requestId);
    res.setHeader('Cache-Control', 'no-store');
    next();
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
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(app.get(ErrorFilter));
  app.useStaticAssets(join(__dirname, '../../frontend/dist'));
  app.enableShutdownHooks();
  await app.init();
  return app;
}
