-- 레벨은 높낮이 비교용이며 부모 관계·권한 상속·현재 승인 제한을 만들지 않는다.
BEGIN;
ALTER TABLE app.responsibilities ADD COLUMN level integer NOT NULL DEFAULT 100 CHECK(level BETWEEN 0 AND 9999);
UPDATE app.responsibilities SET level=CASE code WHEN 'ADMIN' THEN 0 WHEN 'CUSTOMER_MANAGER' THEN 10 ELSE 100 END;
COMMENT ON COLUMN app.responsibilities.level IS 'RESP 비교 레벨. 0이 최상위, 큰 숫자일수록 하위(0~9999). 동급 허용. 신규 기본값 100. SYSTEM/CUSTOMER 구분 및 기능 권한과 독립이며 현재 승인 제한·상속에는 사용하지 않음.';
INSERT INTO public.schema_migrations(version) VALUES('011_resp_level');
COMMIT;
