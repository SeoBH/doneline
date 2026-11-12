-- 008 이후 객체 소유자로 적용한다. 기존 계정/RESP는 변경하지 않고 사용자 삭제 기능을 연다.
BEGIN;
SELECT pg_advisory_xact_lock(720260910);
UPDATE app.screen_buttons SET is_used=true,label='삭제'
 WHERE screen_id IN(SELECT id FROM app.screens WHERE code='USER_REGISTER') AND action_code='DELETE';
-- 기본 운영 RESP의 메뉴만 기본 허용한다. 별도 사용자 정의 메뉴는 운영자가 직접 DELETE를 배정한다.
UPDATE app.menu_screen_buttons mb SET is_allowed=true FROM app.menu_screens ms JOIN app.screens s ON s.id=ms.screen_id
 WHERE mb.menu_screen_id=ms.id AND s.code='USER_REGISTER' AND mb.action_code='DELETE'
 AND ms.menu_id IN(SELECT root_menu_id FROM app.responsibilities WHERE code IN('ADMIN','CUSTOMER_MANAGER'));
COMMENT ON COLUMN app.users.resp_id IS '관리자가 배정하는 RESP ID. 공개 가입은 NULL로 시작하며 승인 시 필수. 재승인은 기존 RESP 유지 또는 변경 가능.';
COMMENT ON COLUMN app.users.account_status IS 'PENDING 승인대기, ACTIVE 승인완료, REJECTED 반려, SUSPENDED 정지. 반려·정지는 사유를 남겨 재승인 가능. 삭제는 별도 상태 없이 실제 행 제거.';
COMMENT ON COLUMN app.users.review_note IS '마지막 반려·정지·재승인 사유. 최초 승인과 직접 등록은 빈 문자열 가능.';
COMMENT ON COLUMN audit.audit_events.user_id IS '처리자 사용자 ID. 감사 원본 보존을 위해 외래키 없음. 삭제된 계정의 인증/조회 이력도 숫자 ID로 유지.';
INSERT INTO public.schema_migrations(version) VALUES('009_user_lifecycle');
COMMIT;
