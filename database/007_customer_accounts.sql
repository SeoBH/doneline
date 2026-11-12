-- 고객사별 가입과 관리자 등록. 기존 계정의 비밀번호·RESP는 보존한다.
-- 006 이후 객체 소유자로 적용한다. 고객사 데이터는 운영자 화면에서 직접 준비한다.
BEGIN;
CREATE TABLE app.customers (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 code text NOT NULL UNIQUE CHECK(code ~ '^[A-Za-z0-9_-]{1,40}$'),
 name text NOT NULL,
 is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE app.corporations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 customer_id bigint NOT NULL REFERENCES app.customers,
 code text NOT NULL,
 name text NOT NULL,
 UNIQUE(customer_id,code), UNIQUE(customer_id,id)
);
CREATE TABLE app.departments (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 customer_id bigint NOT NULL,
 corporation_id bigint NOT NULL,
 code text NOT NULL,
 name text NOT NULL,
 FOREIGN KEY(customer_id,corporation_id) REFERENCES app.corporations(customer_id,id),
 UNIQUE(corporation_id,code), UNIQUE(customer_id,corporation_id,id)
);
ALTER TABLE app.users ALTER COLUMN resp_id DROP NOT NULL;
ALTER TABLE app.users ADD COLUMN customer_id bigint REFERENCES app.customers;
ALTER TABLE app.users ADD COLUMN is_operator boolean NOT NULL DEFAULT false;
ALTER TABLE app.users ADD COLUMN address text NOT NULL DEFAULT '';
ALTER TABLE app.users ADD COLUMN mobile text NOT NULL DEFAULT '';
ALTER TABLE app.users ADD COLUMN account_status text NOT NULL DEFAULT 'ACTIVE'
 CHECK(account_status IN ('PENDING','ACTIVE','REJECTED','SUSPENDED'));
ALTER TABLE app.users ADD COLUMN registration_source text NOT NULL DEFAULT 'ADMIN'
 CHECK(registration_source IN ('ADMIN','SIGNUP'));
ALTER TABLE app.users ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE app.users ADD COLUMN reviewed_by bigint REFERENCES app.users;
ALTER TABLE app.users ADD COLUMN reviewed_at timestamptz;
ALTER TABLE app.users ADD COLUMN review_note text NOT NULL DEFAULT '';
ALTER TABLE app.users ADD CONSTRAINT users_customer_key UNIQUE(customer_id,id);
ALTER TABLE app.users ADD CONSTRAINT users_active_resp CHECK(account_status <> 'ACTIVE' OR resp_id IS NOT NULL);
ALTER TABLE app.users ADD CONSTRAINT users_pending_inactive CHECK(account_status='ACTIVE' OR NOT is_active);
ALTER TABLE app.users ADD CONSTRAINT users_operator_global CHECK(NOT is_operator OR customer_id IS NULL);
CREATE TRIGGER row_version BEFORE UPDATE ON app.users FOR EACH ROW EXECUTE FUNCTION app.increment_row_version();

-- NULL 부서는 법인 전체 범위를 뜻한다. 부서별 범위와 승인 권한을 같은 단위로 보관한다.
CREATE TABLE app.user_scopes (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 customer_id bigint NOT NULL,
 user_id bigint NOT NULL,
 corporation_id bigint NOT NULL,
 department_id bigint,
 can_manage boolean NOT NULL DEFAULT false,
 FOREIGN KEY(customer_id,user_id) REFERENCES app.users(customer_id,id),
 FOREIGN KEY(customer_id,corporation_id) REFERENCES app.corporations(customer_id,id),
 FOREIGN KEY(customer_id,corporation_id,department_id) REFERENCES app.departments(customer_id,corporation_id,id),
 UNIQUE NULLS NOT DISTINCT(user_id,corporation_id,department_id)
);
CREATE INDEX user_scopes_customer_idx ON app.user_scopes(customer_id,corporation_id,user_id);
CREATE TABLE app.customer_responsibilities (
 customer_id bigint NOT NULL REFERENCES app.customers,
 resp_id bigint NOT NULL REFERENCES app.responsibilities,
 PRIMARY KEY(customer_id,resp_id)
);

CREATE OR REPLACE FUNCTION app.revoke_user_sessions() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$
BEGIN
 IF NEW.password_hash IS DISTINCT FROM OLD.password_hash OR NEW.resp_id IS DISTINCT FROM OLD.resp_id
 OR NEW.is_active IS DISTINCT FROM OLD.is_active OR NEW.account_status IS DISTINCT FROM OLD.account_status
 OR NEW.customer_id IS DISTINCT FROM OLD.customer_id OR NEW.is_operator IS DISTINCT FROM OLD.is_operator THEN
  UPDATE app.auth_sessions SET revoked_at=now() WHERE user_id=NEW.id AND revoked_at IS NULL;
 END IF;
 RETURN NEW;
END $$;

UPDATE app.users u SET is_operator=true FROM app.responsibilities r
 WHERE u.resp_id=r.id AND r.code='ADMIN' AND u.login_id='admin' AND u.customer_id IS NULL;
INSERT INTO app.screens(code,name,component_key) VALUES
 ('USER_REGISTER','사용자등록','user-register'),('CUSTOMER_REGISTER','고객사설정','customer-register');
INSERT INTO app.screen_buttons(screen_id,action_code,label,is_used)
 SELECT s.id,a.code,a.label,CASE WHEN s.code='CUSTOMER_REGISTER' THEN a.code IN ('RESET','QUERY','SAVE') ELSE a.used END FROM app.screens s CROSS JOIN
 (VALUES('RESET','초기화',true),('QUERY','조회',true),('SAVE','저장',true),('DELETE','삭제',false),
 ('ETC1','승인',true),('ETC2','반려',true),('ETC3','정지',true),('ETC4','기타4',false)) a(code,label,used)
 WHERE s.code IN ('USER_REGISTER','CUSTOMER_REGISTER');
INSERT INTO app.menu_screens(menu_id,screen_id,sort_order)
 SELECT r.root_menu_id,s.id,20 FROM app.responsibilities r CROSS JOIN app.screens s
 WHERE r.code='ADMIN' AND r.root_menu_id IS NOT NULL AND s.code IN ('USER_REGISTER','CUSTOMER_REGISTER') ON CONFLICT DO NOTHING;
INSERT INTO app.menu_screen_buttons(menu_screen_id,action_code,is_allowed)
 SELECT ms.id,b.action_code,b.is_used FROM app.menu_screens ms JOIN app.screens s ON s.id=ms.screen_id
 JOIN app.screen_buttons b ON b.screen_id=s.id WHERE s.code IN ('USER_REGISTER','CUSTOMER_REGISTER') ON CONFLICT DO NOTHING;
INSERT INTO app.menus(code,name) VALUES('CUSTOMER_ADMIN_ROOT','고객사 관리'),('CUSTOMER_USER_ROOT','업무');
INSERT INTO app.responsibilities(code,name,root_menu_id)
 SELECT 'CUSTOMER_MANAGER','고객사 관리자',id FROM app.menus WHERE code='CUSTOMER_ADMIN_ROOT'
 UNION ALL SELECT 'CUSTOMER_USER','고객사 사용자',id FROM app.menus WHERE code='CUSTOMER_USER_ROOT';
INSERT INTO app.menu_screens(menu_id,screen_id)
 SELECT m.id,s.id FROM app.menus m CROSS JOIN app.screens s WHERE m.code='CUSTOMER_ADMIN_ROOT' AND s.code='USER_REGISTER';
INSERT INTO app.menu_screen_buttons(menu_screen_id,action_code,is_allowed)
 SELECT ms.id,b.action_code,b.is_used FROM app.menu_screens ms JOIN app.menus m ON m.id=ms.menu_id
 JOIN app.screen_buttons b ON b.screen_id=ms.screen_id WHERE m.code='CUSTOMER_ADMIN_ROOT';
GRANT SELECT,INSERT,UPDATE,DELETE ON app.customers,app.corporations,app.departments,app.user_scopes,app.customer_responsibilities TO cpjt_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA app TO cpjt_app;

-- 운영자 감사 상세에서 사용자 상태 전환도 확인한다. 고객사 계정은 이 전역 감사 API에 접근하지 못한다.
CREATE OR REPLACE VIEW audit.config_changes AS
 SELECT id,event_id,entity_type,entity_key,change_type,before_values,after_values FROM audit.audit_changes
 WHERE entity_type IN ('menus','responsibilities','screens','menu_edges','menu_screens','users');

COMMENT ON TABLE app.customers IS 'SaaS 고객사. 가입 링크의 code로 선택 범위를 결정한다.';
COMMENT ON TABLE app.corporations IS '고객사별 법인 코드 원장.';
COMMENT ON TABLE app.departments IS '고객사·법인별 부서 코드 원장.';
COMMENT ON TABLE app.user_scopes IS '사용자의 법인·부서 사용 또는 신청 범위. can_manage는 해당 범위의 관리 권한.';
COMMENT ON TABLE app.customer_responsibilities IS '고객사에 배정 가능한 RESP 허용 목록. 실제 배정은 관리자가 결정.';
COMMENT ON COLUMN app.customers.id IS '자동 생성 고객사 ID.';
COMMENT ON COLUMN app.customers.code IS '고객사 고유 코드. 가입 링크 /?customer=코드에 사용.';
COMMENT ON COLUMN app.customers.name IS '고객사 표시명.';
COMMENT ON COLUMN app.customers.is_active IS 'false이면 신규 가입과 해당 고객사 계정 접근 차단.';
COMMENT ON COLUMN app.corporations.id IS '자동 생성 법인 ID.';
COMMENT ON COLUMN app.corporations.customer_id IS '법인이 속한 고객사 ID.';
COMMENT ON COLUMN app.corporations.code IS '고객사 내 고유 법인 코드.';
COMMENT ON COLUMN app.corporations.name IS '법인 표시명.';
COMMENT ON COLUMN app.departments.id IS '자동 생성 부서 ID.';
COMMENT ON COLUMN app.departments.customer_id IS '부서가 속한 고객사 ID.';
COMMENT ON COLUMN app.departments.corporation_id IS '부서가 속한 법인 ID. 고객사와 함께 외래키 검증.';
COMMENT ON COLUMN app.departments.code IS '법인 내 고유 부서 코드.';
COMMENT ON COLUMN app.departments.name IS '부서 표시명.';
COMMENT ON COLUMN app.user_scopes.id IS '자동 생성 범위 연결 ID.';
COMMENT ON COLUMN app.user_scopes.customer_id IS '연결 고객사. 사용자·법인·부서의 고객사 일치를 외래키로 보장.';
COMMENT ON COLUMN app.user_scopes.user_id IS '사용자 ID. 계정 승인 전에는 요청 범위, 승인 후에는 사용 범위.';
COMMENT ON COLUMN app.user_scopes.corporation_id IS '접근 가능한 또는 신청한 법인 ID.';
COMMENT ON COLUMN app.user_scopes.department_id IS '부서 ID. NULL은 해당 법인의 전체 부서.';
COMMENT ON COLUMN app.user_scopes.can_manage IS '이 범위의 사용자 등록·승인 가능 여부. 운영자만 부여하며 RESP 기능 권한도 필요.';
COMMENT ON COLUMN app.customer_responsibilities.customer_id IS 'RESP를 사용할 고객사 ID.';
COMMENT ON COLUMN app.customer_responsibilities.resp_id IS '관리자가 배정할 수 있는 RESP ID.';
COMMENT ON COLUMN app.users.customer_id IS '계정의 단일 고객사. 기존 공통 관리 계정은 NULL.';
COMMENT ON COLUMN app.users.is_operator IS '고객사 공통 설정과 관리자 범위 부여를 할 플랫폼 운영자 여부.';
COMMENT ON COLUMN app.users.address IS '사용자 주소. 미입력 시 빈 문자열.';
COMMENT ON COLUMN app.users.mobile IS '사용자 휴대전화번호 문자열.';
COMMENT ON COLUMN app.users.account_status IS 'PENDING 승인대기, ACTIVE 사용가능, REJECTED 반려, SUSPENDED 정지.';
COMMENT ON COLUMN app.users.registration_source IS 'ADMIN 관리자 직접 등록(즉시 활성), SIGNUP 고객사 링크 가입(승인대기).';
COMMENT ON COLUMN app.users.version IS '계정 편집·승인 충돌 검사용 버전. UPDATE마다 증가.';
COMMENT ON COLUMN app.users.reviewed_by IS '직접 등록 또는 마지막 승인·반려·정지 처리자. 미처리 NULL.';
COMMENT ON COLUMN app.users.reviewed_at IS '마지막 관리 처리 시각. 미처리 NULL.';
COMMENT ON COLUMN app.users.review_note IS '반려·정지 사유. 미입력 빈 문자열.';
COMMENT ON COLUMN app.users.resp_id IS '실제 권한 RESP. 승인대기·반려 계정은 NULL 가능, 활성 계정에는 필수.';
INSERT INTO public.schema_migrations(version) VALUES('007_customer_accounts');
COMMIT;
