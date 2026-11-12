-- DB 소유자로 실행하는 앱 권한 구성. 메뉴 연결 직접 쓰기는 막고 함수 실행만 허용한다. 감사 기록은 추가만 가능하며 수정·삭제는 차단한다.
-- Run as the database owner after migrations. The cpjt_app login must already exist.
-- Apply to cpjt_dev and cpjt_backend_test separately; do not grant access to other projects.
BEGIN;
GRANT USAGE ON SCHEMA app, audit TO cpjt_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  app.users, app.responsibilities, app.menus, app.screens,
  app.screen_buttons, app.menu_screens, app.menu_screen_buttons,
  app.auth_sessions, app.login_limits, app.idempotency_records
TO cpjt_app;
GRANT SELECT, UPDATE ON app.authorization_state TO cpjt_app;
GRANT SELECT ON app.menu_edges TO cpjt_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.menu_edges FROM cpjt_app;
GRANT EXECUTE ON FUNCTION app.set_menu_edge(bigint,bigint,integer,boolean) TO cpjt_app;
GRANT EXECUTE ON FUNCTION app.set_menu_edge(bigint,bigint,integer,boolean,boolean) TO cpjt_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO cpjt_app;
GRANT INSERT ON audit.audit_events, audit.audit_changes, audit.error_details TO cpjt_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit.audit_events, audit.audit_changes, audit.error_details FROM cpjt_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA audit TO cpjt_app;
GRANT SELECT ON audit.event_summary, audit.config_changes TO cpjt_app;
COMMIT;
