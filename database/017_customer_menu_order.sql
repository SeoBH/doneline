-- 고객사 관리자 메뉴(CUSTOMER_ADMIN_ROOT)에서 주 업무인 '고객 요청'을 맨 위에 둔다.
-- 2차 사용성 테스트에서 고객사 관리자가 사용자등록부터 보게 되어 요청 확인을 놓치는 문제가 있었다.
-- 메뉴 화면은 sort_order가 작은 순서로 표시된다. DB 소유자(관리 계정)로 실행한다.
BEGIN;
UPDATE app.menu_screens ms SET sort_order = CASE s.code
    WHEN 'SR_PORTAL' THEN 0
    WHEN 'USER_REGISTER' THEN 10
    WHEN 'CORPORATION_REGISTER' THEN 21
    WHEN 'DEPARTMENT_REGISTER' THEN 22
    ELSE ms.sort_order END
  FROM app.menus m, app.screens s
  WHERE m.id = ms.menu_id AND s.id = ms.screen_id AND m.code = 'CUSTOMER_ADMIN_ROOT';
INSERT INTO public.schema_migrations (version) VALUES ('017_customer_menu_order');
COMMIT;
