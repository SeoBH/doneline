-- 007 이후 객체 소유자로 실행한다. 비밀번호는 보존하고 권한 판단을 RESP로 통일한다.
BEGIN;
SELECT pg_advisory_xact_lock(720260910);
ALTER TABLE app.responsibilities ADD COLUMN authority_type text NOT NULL DEFAULT 'CUSTOMER'
 CHECK(authority_type IN ('SYSTEM','CUSTOMER'));
UPDATE app.responsibilities SET authority_type='SYSTEM' WHERE code='ADMIN';
-- 기존 운영자 RESP도 보존한다. 고객사와 공유된 RESP는 자동 승격하지 않고 중단한다.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM app.users a JOIN app.users b ON b.resp_id=a.resp_id
 WHERE a.is_operator AND b.customer_id IS NOT NULL) THEN
 RAISE EXCEPTION '운영자와 고객사 사용자가 공유하는 RESP를 먼저 분리해주세요.';
 END IF;
END $$;
UPDATE app.responsibilities r SET authority_type='SYSTEM'
 WHERE EXISTS(SELECT 1 FROM app.users u WHERE u.resp_id=r.id AND u.is_operator);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM app.users u JOIN app.responsibilities r ON r.id=u.resp_id
 WHERE r.authority_type='SYSTEM' AND u.customer_id IS NOT NULL) THEN
 RAISE EXCEPTION 'SYSTEM RESP와 고객사 계정의 연결을 먼저 분리해주세요.';
 END IF;
END $$;
CREATE TABLE app.user_corporations(
 customer_id bigint NOT NULL,
 user_id bigint NOT NULL,
 corporation_id bigint NOT NULL,
 PRIMARY KEY(user_id,corporation_id),
 UNIQUE(customer_id,user_id,corporation_id),
 FOREIGN KEY(customer_id,user_id) REFERENCES app.users(customer_id,id),
 FOREIGN KEY(customer_id,corporation_id) REFERENCES app.corporations(customer_id,id)
);
INSERT INTO app.user_corporations SELECT DISTINCT customer_id,user_id,corporation_id FROM app.user_scopes;
-- 과거 전체 부서(NULL)는 현재 부서로 전환한다. 이후 생성한 부서는 별도로 매핑한다.
INSERT INTO app.user_scopes(customer_id,user_id,corporation_id,department_id)
 SELECT s.customer_id,s.user_id,s.corporation_id,d.id FROM app.user_scopes s
 JOIN app.departments d ON d.customer_id=s.customer_id AND d.corporation_id=s.corporation_id
 WHERE s.department_id IS NULL ON CONFLICT DO NOTHING;
DELETE FROM app.user_scopes WHERE department_id IS NULL;
ALTER TABLE app.user_scopes ALTER COLUMN department_id SET NOT NULL;
ALTER TABLE app.user_scopes DROP COLUMN can_manage;
ALTER TABLE app.user_scopes ADD FOREIGN KEY(customer_id,user_id,corporation_id)
 REFERENCES app.user_corporations(customer_id,user_id,corporation_id);
-- 미승인 신청자가 과거에 고른 범위는 확정 권한으로 이월하지 않는다.
DELETE FROM app.user_scopes s USING app.users u WHERE u.id=s.user_id AND u.account_status='PENDING';
DELETE FROM app.user_corporations s USING app.users u WHERE u.id=s.user_id AND u.account_status='PENDING';
CREATE OR REPLACE FUNCTION app.revoke_user_sessions() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$
BEGIN
 IF NEW.password_hash IS DISTINCT FROM OLD.password_hash OR NEW.resp_id IS DISTINCT FROM OLD.resp_id
 OR NEW.is_active IS DISTINCT FROM OLD.is_active OR NEW.account_status IS DISTINCT FROM OLD.account_status
 OR NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
 UPDATE app.auth_sessions SET revoked_at=now() WHERE user_id=NEW.id AND revoked_at IS NULL;
 END IF;
 RETURN NEW;
END $$;
ALTER TABLE app.users DROP COLUMN is_operator;
DROP TABLE app.customer_responsibilities;
-- 로그인·요청·세션에서 동일한 판정을 사용한다. 모든 선택 법인에 실제 부서가 필요하다.
CREATE VIEW app.account_access AS
 SELECT u.id,r.authority_type,
 (r.authority_type='SYSTEM' OR
 (u.customer_id IS NOT NULL AND EXISTS(SELECT 1 FROM app.user_corporations uc WHERE uc.user_id=u.id)
 AND NOT EXISTS(SELECT 1 FROM app.user_corporations uc WHERE uc.user_id=u.id
 AND NOT EXISTS(SELECT 1 FROM app.user_scopes s WHERE s.user_id=uc.user_id AND s.corporation_id=uc.corporation_id)))) AS mapping_ready,
 (u.is_active AND u.account_status='ACTIVE' AND r.is_active AND
 (r.authority_type='SYSTEM' OR EXISTS(SELECT 1 FROM app.customers t WHERE t.id=u.customer_id AND t.is_active))) AS account_enabled
 FROM app.users u LEFT JOIN app.responsibilities r ON r.id=u.resp_id;
CREATE FUNCTION app.mapping_changed() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$
DECLARE target bigint;
BEGIN
 target := CASE WHEN TG_OP='DELETE' THEN OLD.user_id ELSE NEW.user_id END;
 UPDATE app.users SET updated_at=now() WHERE id=target;
 UPDATE app.auth_sessions SET revoked_at=now() WHERE user_id=target AND revoked_at IS NULL;
 IF TG_OP='UPDATE' AND OLD.user_id IS DISTINCT FROM NEW.user_id THEN
 UPDATE app.users SET updated_at=now() WHERE id=OLD.user_id;
 UPDATE app.auth_sessions SET revoked_at=now() WHERE user_id=OLD.user_id AND revoked_at IS NULL;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER mapping_changed AFTER INSERT OR UPDATE OR DELETE ON app.user_corporations FOR EACH ROW EXECUTE FUNCTION app.mapping_changed();
CREATE TRIGGER mapping_changed AFTER INSERT OR UPDATE OR DELETE ON app.user_scopes FOR EACH ROW EXECUTE FUNCTION app.mapping_changed();
-- 배정된 RESP의 구분 변경으로 사용자를 일괄 승격하는 것을 막는다.
CREATE FUNCTION app.check_authority_change() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$
BEGIN
 IF NEW.authority_type IS DISTINCT FROM OLD.authority_type AND EXISTS(SELECT 1 FROM app.users WHERE resp_id=OLD.id) THEN
 RAISE EXCEPTION '사용자에게 배정된 RESP의 접근 구분은 변경할 수 없습니다.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER check_authority_change BEFORE UPDATE ON app.responsibilities FOR EACH ROW EXECUTE FUNCTION app.check_authority_change();
ALTER TABLE app.customers ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE app.corporations ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE app.departments ADD COLUMN version integer NOT NULL DEFAULT 1;
CREATE TRIGGER row_version BEFORE UPDATE ON app.customers FOR EACH ROW EXECUTE FUNCTION app.increment_row_version();
CREATE TRIGGER row_version BEFORE UPDATE ON app.corporations FOR EACH ROW EXECUTE FUNCTION app.increment_row_version();
CREATE TRIGGER row_version BEFORE UPDATE ON app.departments FOR EACH ROW EXECUTE FUNCTION app.increment_row_version();
UPDATE app.screens SET name='고객사등록' WHERE code='CUSTOMER_REGISTER';
INSERT INTO app.screens(code,name,component_key) VALUES
 ('CORPORATION_REGISTER','법인등록','corporation-register'),('DEPARTMENT_REGISTER','부서등록','department-register');
INSERT INTO app.screen_buttons(screen_id,action_code,label,is_used)
 SELECT s.id,a.code,a.label,a.used FROM app.screens s CROSS JOIN
 (VALUES('RESET','초기화',true),('QUERY','조회',true),('SAVE','저장',true),('DELETE','삭제',true),
 ('ETC1','기타1',false),('ETC2','기타2',false),('ETC3','기타3',false),('ETC4','기타4',false)) a(code,label,used)
 WHERE s.code IN ('CORPORATION_REGISTER','DEPARTMENT_REGISTER');
UPDATE app.screen_buttons SET is_used=true WHERE screen_id IN(SELECT id FROM app.screens WHERE code='CUSTOMER_REGISTER') AND action_code='DELETE';
UPDATE app.screen_buttons SET is_used=true,label='매핑 저장' WHERE screen_id IN(SELECT id FROM app.screens WHERE code='USER_REGISTER') AND action_code='ETC4';
INSERT INTO app.menu_screens(menu_id,screen_id,sort_order)
 SELECT r.root_menu_id,s.id,21 FROM app.responsibilities r CROSS JOIN app.screens s
 WHERE r.code IN('ADMIN','CUSTOMER_MANAGER') AND s.code IN('CORPORATION_REGISTER','DEPARTMENT_REGISTER') ON CONFLICT DO NOTHING;
INSERT INTO app.menu_screen_buttons(menu_screen_id,action_code,is_allowed)
 SELECT ms.id,b.action_code,b.is_used FROM app.menu_screens ms JOIN app.screens s ON s.id=ms.screen_id JOIN app.screen_buttons b ON b.screen_id=s.id
 WHERE s.code IN('CORPORATION_REGISTER','DEPARTMENT_REGISTER') ON CONFLICT DO NOTHING;
UPDATE app.menu_screen_buttons mb SET is_allowed=true FROM app.menu_screens ms JOIN app.screens s ON s.id=ms.screen_id
 WHERE mb.menu_screen_id=ms.id AND
 ((s.code='CUSTOMER_REGISTER' AND mb.action_code='DELETE') OR
 (s.code='USER_REGISTER' AND mb.action_code='ETC4' AND ms.menu_id IN(SELECT root_menu_id FROM app.responsibilities WHERE code IN('ADMIN','CUSTOMER_MANAGER'))));
GRANT SELECT ON app.account_access TO doneline_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON app.user_corporations TO doneline_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA app TO doneline_app;
CREATE OR REPLACE VIEW audit.config_changes AS
 SELECT id,event_id,entity_type,entity_key,change_type,before_values,after_values FROM audit.audit_changes
 WHERE entity_type IN('menus','responsibilities','screens','menu_edges','menu_screens','users','user_scopes','customers','corporations','departments');
COMMENT ON COLUMN app.responsibilities.authority_type IS '접근 구분 SYSTEM 전체 고객사(매핑 불필요), CUSTOMER 자기 고객사. 기본 CUSTOMER. 기능은 화면·버튼 권한으로 별도 검사.';
COMMENT ON TABLE app.user_corporations IS '사용자별 법인 매핑. 법인만 저장할 수 있으나 각 법인에 실제 부서가 있어야 로그인 가능.';
COMMENT ON COLUMN app.user_corporations.customer_id IS '사용자와 법인이 속한 고객사 ID. 복합 외래키로 일치 검증.';
COMMENT ON COLUMN app.user_corporations.user_id IS '매핑할 사용자 ID.';
COMMENT ON COLUMN app.user_corporations.corporation_id IS '선택한 법인 ID. 미지정 법인도 일반 코드와 동일하게 취급.';
COMMENT ON TABLE app.user_scopes IS '운영담당자가 확정한 사용자별 부서 매핑. 법인 매핑 아래에 연결하며 전체 범위 생략값은 없음.';
COMMENT ON COLUMN app.user_scopes.corporation_id IS '부서가 속한 확정 법인 ID. 사용자 법인 매핑에 존재해야 함.';
COMMENT ON COLUMN app.users.registration_source IS 'ADMIN 직접 등록(승인 생략, CUSTOMER 매핑 별도), SIGNUP 고객사 링크 가입(승인·매핑 필요).';
COMMENT ON COLUMN app.user_scopes.department_id IS '필수 부서 ID. 미지정 부서도 실제 등록된 ID를 사용하며 전체 접근을 의미하지 않음.';
COMMENT ON COLUMN app.user_scopes.user_id IS '부서 접근 범위를 부여받는 사용자 ID. 회원가입자는 직접 매핑하지 않음.';
COMMENT ON COLUMN app.users.resp_id IS '가입 시 신청하고 승인자가 확정하는 RESP ID. 기존 미배정 신청은 NULL, 활성 계정은 필수.';
COMMENT ON COLUMN app.customers.version IS '동시 편집 검사용 버전. 기본 1, UPDATE마다 1 증가.';
COMMENT ON COLUMN app.corporations.version IS '동시 편집 검사용 버전. 기본 1, UPDATE마다 1 증가.';
COMMENT ON COLUMN app.departments.version IS '동시 편집 검사용 버전. 기본 1, UPDATE마다 1 증가.';
COMMENT ON VIEW app.account_access IS '인증 공통 판정. account_enabled와 mapping_ready가 모두 true여야 로그인·세션 사용 가능.';
COMMENT ON COLUMN app.account_access.id IS '판정 대상 사용자 ID.';
COMMENT ON COLUMN app.account_access.authority_type IS '현재 RESP의 SYSTEM/CUSTOMER 구분. 미배정은 NULL.';
COMMENT ON COLUMN app.account_access.mapping_ready IS 'SYSTEM은 true. CUSTOMER는 법인 1개 이상과 각 법인별 부서 1개 이상일 때 true.';
COMMENT ON COLUMN app.account_access.account_enabled IS '사용자 승인·활성, RESP 활성, CUSTOMER 고객사 활성 조건 충족 여부.';
UPDATE app.auth_sessions SET revoked_at=now() WHERE user_id IS NOT NULL AND revoked_at IS NULL;
INSERT INTO public.schema_migrations(version) VALUES('008_customer_management');
COMMIT;
