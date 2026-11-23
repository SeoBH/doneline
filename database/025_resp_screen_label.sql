-- 역할 등록 화면 이름을 'RESP등록'에서 '역할등록'으로 바꾸기(QA P3 잔여 'RESP' 라벨, 2026-11-23).
-- 사용자등록·감사 로그는 이미 '역할'로 보여 주므로 메뉴에 보이는 화면 이름도 맞춘다.
-- 화면 구성(app.screens)은 모든 업체가 함께 쓰는 공통 구성이다.
-- 운영자가 화면등록에서 이름을 직접 바꿨다면 그 이름을 지키기 위해 처음 이름 그대로인 행만 고친다.
-- 내부 코드(RESP_REGISTER)와 권한 검사는 바꾸지 않는다.
BEGIN;

UPDATE app.screens SET name = '역할등록' WHERE code = 'RESP_REGISTER' AND name = 'RESP등록';

INSERT INTO public.schema_migrations (version) VALUES ('025_resp_screen_label');
COMMIT;
