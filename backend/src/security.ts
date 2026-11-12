/**
 * API 공통 접근 검사. 변경 요청의 Origin/CSRF, 로그인 상태, 최초 비밀번호 변경, 메뉴·화면·버튼 권한 순으로 확인한다.
 * Public API도 변경 요청의 CSRF 검사는 적용된다.
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { Db, useWorkspace } from './db';
import { settings } from './config';
import { Permissions } from './permissions';
export const Public = () => SetMetadata('public', true);
export const AllowPasswordChange = () => SetMetadata('allowPasswordChange', true);
export const Permission = (screen: string, action: string) =>
  SetMetadata('permission', { screen, action });
export interface AppRequest extends Request {
  requestId: string;
  actor?: {
    id: string;
    resp_id: string;
    display_name: string;
    must_change_password: boolean;
    customer_id: string | null;
    authority_type: 'SYSTEM' | 'CUSTOMER';
    workspace_id: string;
    // 운영 워크스페이스 소속 여부. 화면·메뉴·RESP 공통 구성 변경 허용 판단에 사용한다.
    is_platform: boolean;
  };
}
@Injectable()
export class SecurityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: Db,
    private readonly permissions: Permissions,
  ) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.get('origin') !== settings.origin)
        throw new ForbiddenException('허용되지 않은 요청 출처입니다.');
      // 길이가 다른 버퍼는 먼저 거절하여 timingSafeEqual의 예외 없이 비교한다.
      const expected = req.session?.csrf,
        supplied = req.get('x-csrf-token');
      if (
        !expected ||
        !supplied ||
        Buffer.byteLength(expected) !== Buffer.byteLength(supplied) ||
        !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
      )
        throw new ForbiddenException('요청 인증 정보가 올바르지 않습니다.');
    }
    if (this.reflector.get('public', ctx.getHandler())) return true;
    if (!req.session?.userId || !req.session.workspaceId)
      throw new UnauthorizedException('로그인이 필요합니다.');
    // 이후 이 요청의 모든 DB 작업은 로그인 사용자의 워크스페이스 안에서만 행을 보고 쓴다.
    useWorkspace(req.session.workspaceId);
    const { rows } = await this.db.query(
      `SELECT u.id,u.resp_id,u.display_name,u.must_change_password,u.customer_id,a.authority_type,u.workspace_id,w.is_platform
       FROM app.users u JOIN app.account_access a ON a.id=u.id JOIN app.workspaces w ON w.id=u.workspace_id
       WHERE u.id=$1 AND a.account_enabled AND a.mapping_ready`,
      [req.session.userId],
    );
    if (!rows[0]) throw new UnauthorizedException('로그인이 필요합니다.');
    req.actor = rows[0];
    if (
      req.actor!.must_change_password &&
      !this.reflector.get('allowPasswordChange', ctx.getHandler())
    )
      throw new ForbiddenException('먼저 비밀번호를 변경해주세요.');
    let permission = this.reflector.get<{ screen: string; action: string }>(
      'permission',
      ctx.getHandler(),
    );
    // 등록 종류를 고정 매핑으로 변환해 다른 화면의 권한을 대신 사용하는 것을 막는다.
    const registerAction = this.reflector.get<string>('registerPermission', ctx.getHandler());
    if (registerAction) {
      const codes: Record<string, string> = {
        screens: 'SCREEN_REGISTER',
        menus: 'MENU_REGISTER',
        responsibilities: 'RESP_REGISTER',
      };
      const code = Object.hasOwn(codes, String(req.params.kind))
        ? codes[String(req.params.kind)]
        : undefined;
      if (!code) throw new ForbiddenException('등록 화면이 없습니다.');
      permission = { screen: code, action: registerAction };
    }
    const catalogAction = this.reflector.get<string>('catalogPermission', ctx.getHandler());
    if (catalogAction) {
      const codes: Record<string, string> = {
        customers: 'CUSTOMER_REGISTER',
        corporations: 'CORPORATION_REGISTER',
        departments: 'DEPARTMENT_REGISTER',
      };
      const code = Object.hasOwn(codes, String(req.params.kind))
        ? codes[String(req.params.kind)]
        : undefined;
      if (!code) throw new ForbiddenException('등록 화면이 없습니다.');
      permission = { screen: code, action: catalogAction };
    }
    if (permission) {
      // 기존 메뉴·RESP·감사 API는 플랫폼 공통 데이터다. 고객사 관리자는 이 경로를 사용할 수 없다.
      if (
        req.actor!.authority_type !== 'SYSTEM' &&
        [
          'SCREEN_REGISTER',
          'MENU_REGISTER',
          'RESP_REGISTER',
          'AUDIT',
          'CUSTOMER_REGISTER',
        ].includes(permission.screen)
      )
        throw new ForbiddenException('고객사 계정에서 사용할 수 없는 공통 관리 기능입니다.');
      // 화면·메뉴·RESP는 모든 워크스페이스가 함께 쓰는 구성이다. 업체 관리자가 자기 RESP에
      // 해당 메뉴를 붙이더라도 운영 워크스페이스가 아니면 거절해 다른 업체에 영향을 주지 못하게 한다.
      if (
        !req.actor!.is_platform &&
        ['SCREEN_REGISTER', 'MENU_REGISTER', 'RESP_REGISTER'].includes(permission.screen)
      )
        throw new ForbiddenException('운영 워크스페이스에서만 사용할 수 있는 공통 구성 기능입니다.');
      const menu = req.get('x-menu-id');
      if (!menu || !/^\d{1,18}$/.test(menu)) throw new ForbiddenException('메뉴 권한이 없습니다.');
      if (
        !(await this.permissions.allows(
          req.actor!.resp_id,
          menu,
          permission.screen,
          permission.action,
        ))
      )
        throw new ForbiddenException('메뉴 권한이 없습니다.');
    }
    return true;
  }
}
