-- 셀프 가입한 업체 관리자에게 배정할 공통 RESP(WORKSPACE_ADMIN)와 시작 메뉴.
-- 자기 워크스페이스의 감사 로그·사용자·고객사·법인·부서 관리만 포함하고,
-- 모든 업체가 함께 쓰는 화면·메뉴·RESP 등록은 포함하지 않는다(운영 워크스페이스 ADMIN 전용).
-- DB 소유자(관리 계정)로 실행한다.
BEGIN;

-- 새 환경에서는 감사 화면을 seed가 만들기 전에 이 마이그레이션이 실행되므로 없으면 만든다.
INSERT INTO app.screens (code, name, purpose, component_key)
  VALUES ('AUDIT', '감사 로그', '로그인과 업무 처리 이력', 'audit') ON CONFLICT (code) DO NOTHING;
INSERT INTO app.screen_buttons (screen_id, action_code, label, is_used)
  SELECT id, 'QUERY', '조회', true FROM app.screens WHERE code = 'AUDIT' ON CONFLICT DO NOTHING;

INSERT INTO app.menus (code, name) VALUES ('WORKSPACE_ADMIN_ROOT', '업체 관리') ON CONFLICT (code) DO NOTHING;
INSERT INTO app.menu_screens (menu_id, screen_id, sort_order)
  SELECT m.id, s.id, v.sort_order FROM app.menus m
  CROSS JOIN (VALUES ('CUSTOMER_REGISTER', 10), ('CORPORATION_REGISTER', 11), ('DEPARTMENT_REGISTER', 12),
    ('USER_REGISTER', 20), ('AUDIT', 90)) v (code, sort_order)
  JOIN app.screens s ON s.code = v.code
  WHERE m.code = 'WORKSPACE_ADMIN_ROOT' ON CONFLICT DO NOTHING;
-- 화면에서 사용 중인 버튼은 모두 허용한다. 사용하지 않는 버튼은 허용해도 서버 권한 계산에서 제외된다.
INSERT INTO app.menu_screen_buttons (menu_screen_id, action_code, is_allowed)
  SELECT ms.id, b.action_code, b.is_used FROM app.menu_screens ms
  JOIN app.menus m ON m.id = ms.menu_id JOIN app.screen_buttons b ON b.screen_id = ms.screen_id
  WHERE m.code = 'WORKSPACE_ADMIN_ROOT' ON CONFLICT DO NOTHING;

-- workspace_id NULL = 모든 워크스페이스가 배정할 수 있는 공통 RESP. 레벨 5는 ADMIN(0)보다 낮고 고객사 관리자(10)보다 높다.
INSERT INTO app.responsibilities (code, name, root_menu_id, authority_type, level)
  SELECT 'WORKSPACE_ADMIN', '업체 관리자', id, 'SYSTEM', 5 FROM app.menus WHERE code = 'WORKSPACE_ADMIN_ROOT'
  ON CONFLICT (code) DO NOTHING;

INSERT INTO public.schema_migrations (version) VALUES ('013_workspace_admin');
COMMIT;
