-- 워크스페이스(SaaS 계약 업체) 계층. 고객사·사용자·감사 기록을 워크스페이스별로 분리하고
-- PostgreSQL 행 수준 보안(RLS)으로 다른 워크스페이스의 행을 DB가 직접 숨긴다.
-- 앱은 트랜잭션마다 set_config('app.workspace_id', ..., true)로 현재 워크스페이스를 지정한다.
-- 지정이 없으면 RLS 대상 테이블은 빈 결과가 되고 쓰기는 거부된다(실패 시 닫힘).
-- 메뉴·화면·버튼은 플랫폼 공통 구성으로 남기며, RESP는 공통(NULL) 또는 특정 워크스페이스 전용이다.
-- DB 소유자(관리 계정)로 실행한다. 소유자는 RLS를 우회하므로 마이그레이션·백필이 가능하다.
BEGIN;

CREATE TABLE app.workspaces (
  id bigserial PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  plan text NOT NULL DEFAULT 'FREE' CHECK (plan IN ('FREE', 'TEAM', 'BUSINESS')),
  is_platform boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX workspaces_single_platform ON app.workspaces (is_platform) WHERE is_platform;
INSERT INTO app.workspaces (code, name, is_platform) VALUES ('platform', 'Doneline 운영', true);
COMMENT ON TABLE app.workspaces IS 'SaaS 계약 업체(워크스페이스). 고객사·사용자·감사 기록의 최상위 소유 단위이며 행 수준 보안의 기준.';
COMMENT ON COLUMN app.workspaces.id IS '워크스페이스 식별자. 세션 설정 app.workspace_id와 각 테이블 workspace_id가 참조.';
COMMENT ON COLUMN app.workspaces.code IS '영문 소문자·숫자·하이픈 2~40자의 고유 코드. 주소·운영 식별용이며 변경을 전제하지 않음.';
COMMENT ON COLUMN app.workspaces.name IS '화면 표시용 업체명(1~120자).';
COMMENT ON COLUMN app.workspaces.status IS 'ACTIVE=사용 중, SUSPENDED=정지(소속 계정 로그인·세션 불가). 기본 ACTIVE.';
COMMENT ON COLUMN app.workspaces.plan IS '요금제 FREE/TEAM/BUSINESS. 기본 FREE. 현재 기능 제한에는 사용하지 않음.';
COMMENT ON COLUMN app.workspaces.is_platform IS 'Doneline 운영 워크스페이스 여부. 최대 1개. 화면·메뉴·RESP 공통 구성 변경은 이 워크스페이스의 SYSTEM 계정만 가능.';
COMMENT ON COLUMN app.workspaces.created_at IS '생성 시각.';
COMMENT ON COLUMN app.workspaces.updated_at IS '마지막 변경 시각.';

-- 현재 트랜잭션의 워크스페이스. 설정이 없거나 빈 값이면 NULL을 돌려 RLS 비교가 항상 거짓이 되게 한다.
CREATE FUNCTION app.current_workspace_id() RETURNS bigint LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::bigint $$;
COMMENT ON FUNCTION app.current_workspace_id() IS '세션 설정 app.workspace_id를 bigint로 반환. 미설정이면 NULL(어떤 행과도 일치하지 않음).';

-- 고객사: 워크스페이스 소유. 코드는 워크스페이스 안에서만 고유하다(서로 다른 업체가 같은 고객사를 가질 수 있음).
ALTER TABLE app.customers ADD COLUMN workspace_id bigint REFERENCES app.workspaces (id);
UPDATE app.customers SET workspace_id = (SELECT id FROM app.workspaces WHERE is_platform);
ALTER TABLE app.customers ALTER COLUMN workspace_id SET NOT NULL,
  ALTER COLUMN workspace_id SET DEFAULT app.current_workspace_id();
ALTER TABLE app.customers DROP CONSTRAINT customers_code_key,
  ADD CONSTRAINT customers_workspace_code_key UNIQUE (workspace_id, code),
  ADD CONSTRAINT customers_id_workspace_key UNIQUE (id, workspace_id);
-- 가입 링크용 추측 불가 토큰. 고객사 코드는 짧고 추측하기 쉬워 링크에 쓰지 않는다.
ALTER TABLE app.customers ADD COLUMN signup_token text NOT NULL UNIQUE
  DEFAULT replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
COMMENT ON COLUMN app.customers.workspace_id IS '소유 워크스페이스(app.workspaces.id). 기본값은 현재 트랜잭션의 워크스페이스.';
COMMENT ON COLUMN app.customers.code IS '워크스페이스 안에서 고유한 고객사 코드. 저장 후 변경 불가.';
COMMENT ON COLUMN app.customers.signup_token IS '고객사 회원가입 링크 토큰(무작위 64자 16진수, 전체 고유). 링크가 유출되면 교체하는 용도로 분리.';

-- 사용자: SYSTEM 계정은 고객사가 없으므로 고객사를 거치지 않고 워크스페이스를 직접 가진다.
ALTER TABLE app.users ADD COLUMN workspace_id bigint REFERENCES app.workspaces (id);
UPDATE app.users SET workspace_id = (SELECT id FROM app.workspaces WHERE is_platform);
ALTER TABLE app.users ALTER COLUMN workspace_id SET NOT NULL,
  ALTER COLUMN workspace_id SET DEFAULT app.current_workspace_id();
-- 고객사가 있는 사용자는 같은 워크스페이스의 고객사에만 속할 수 있다(customer_id NULL이면 검사 생략).
ALTER TABLE app.users ADD CONSTRAINT users_customer_workspace_fkey
  FOREIGN KEY (customer_id, workspace_id) REFERENCES app.customers (id, workspace_id);
CREATE INDEX users_workspace_idx ON app.users (workspace_id);
COMMENT ON COLUMN app.users.workspace_id IS '소속 워크스페이스(app.workspaces.id). 고객사가 있으면 그 고객사의 워크스페이스와 같아야 함. 로그인 ID는 전체에서 고유.';

-- RESP: NULL은 모든 워크스페이스가 배정할 수 있는 공통 RESP, 값이 있으면 해당 워크스페이스 전용.
-- 기존 SYSTEM RESP(ADMIN 등)는 화면·메뉴 구성 권한을 포함하므로 운영 워크스페이스 전용으로 옮긴다.
ALTER TABLE app.responsibilities ADD COLUMN workspace_id bigint REFERENCES app.workspaces (id);
UPDATE app.responsibilities SET workspace_id = (SELECT id FROM app.workspaces WHERE is_platform)
  WHERE authority_type = 'SYSTEM';
COMMENT ON COLUMN app.responsibilities.workspace_id IS 'NULL=모든 워크스페이스 공통 RESP, 값=해당 워크스페이스 전용(app.workspaces.id). 기본 NULL.';

-- 세션: 토큰 해시로만 조회하므로 RLS 없이 두고, 로그인 후 워크스페이스를 기록해 요청 처리 시 지정한다.
ALTER TABLE app.auth_sessions ADD COLUMN workspace_id bigint REFERENCES app.workspaces (id);
COMMENT ON COLUMN app.auth_sessions.workspace_id IS '로그인한 사용자의 워크스페이스. 로그인 전 세션은 NULL.';

-- 감사: 워크스페이스를 알 수 없는 요청(없는 계정 로그인 실패 등)은 NULL로 남고 앱에서는 조회되지 않는다.
ALTER TABLE audit.audit_events ADD COLUMN workspace_id bigint DEFAULT app.current_workspace_id();
ALTER TABLE audit.audit_changes ADD COLUMN workspace_id bigint DEFAULT app.current_workspace_id();
ALTER TABLE audit.error_details ADD COLUMN workspace_id bigint DEFAULT app.current_workspace_id();
UPDATE audit.audit_events SET workspace_id = (SELECT id FROM app.workspaces WHERE is_platform);
UPDATE audit.audit_changes SET workspace_id = (SELECT id FROM app.workspaces WHERE is_platform);
UPDATE audit.error_details SET workspace_id = (SELECT id FROM app.workspaces WHERE is_platform);
CREATE INDEX audit_events_workspace_idx ON audit.audit_events (workspace_id, occurred_at DESC);
COMMENT ON COLUMN audit.audit_events.workspace_id IS '기록 당시 워크스페이스(app.workspaces.id). 알 수 없으면 NULL이며 앱 조회 대상이 아님.';
COMMENT ON COLUMN audit.audit_changes.workspace_id IS '기록 당시 워크스페이스. 감사 이벤트와 같은 값.';
COMMENT ON COLUMN audit.error_details.workspace_id IS '기록 당시 워크스페이스. 감사 이벤트와 같은 값.';

-- 정지된 워크스페이스의 계정은 로그인·세션 유지가 되지 않도록 계정 활성 조건에 포함한다.
CREATE OR REPLACE VIEW app.account_access AS
SELECT u.id, r.authority_type,
  ((r.authority_type = 'SYSTEM') OR (u.customer_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM app.user_corporations uc WHERE uc.user_id = u.id)
    AND NOT EXISTS (SELECT 1 FROM app.user_corporations uc WHERE uc.user_id = u.id
      AND NOT EXISTS (SELECT 1 FROM app.user_scopes s WHERE s.user_id = uc.user_id AND s.corporation_id = uc.corporation_id)))) AS mapping_ready,
  (u.is_active AND u.account_status = 'ACTIVE' AND r.is_active
    AND EXISTS (SELECT 1 FROM app.workspaces w WHERE w.id = u.workspace_id AND w.status = 'ACTIVE')
    AND ((r.authority_type = 'SYSTEM') OR EXISTS (SELECT 1 FROM app.customers t WHERE t.id = u.customer_id AND t.is_active))) AS account_enabled
FROM app.users u LEFT JOIN app.responsibilities r ON r.id = u.resp_id;
-- 뷰는 기본적으로 소유자 권한으로 실행되어 RLS를 우회한다. 호출자 권한으로 실행해 RLS를 그대로 적용한다.
ALTER VIEW app.account_access SET (security_invoker = true);
ALTER VIEW audit.event_summary SET (security_invoker = true);
ALTER VIEW audit.config_changes SET (security_invoker = true);
COMMENT ON VIEW app.account_access IS '사용자별 접근 구분·매핑 완료·계정 사용 가능 여부. 워크스페이스 정지·RESP·고객사 비활성을 반영하며 호출자 RLS 적용.';

-- RESP 접근 구분 변경 검사는 다른 워크스페이스의 배정 사용자까지 확인해야 하므로 소유자 권한으로 실행한다.
ALTER FUNCTION app.check_authority_change() SECURITY DEFINER SET search_path = pg_catalog, app;

-- 행 수준 보안. 앱 계정은 소유자가 아니므로 아래 정책이 항상 적용된다.
ALTER TABLE app.workspaces ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_self ON app.workspaces FOR SELECT USING (id = app.current_workspace_id());
DO $$ DECLARE t text; BEGIN
  -- 워크스페이스를 직접 가진 테이블
  FOREACH t IN ARRAY ARRAY['app.customers', 'app.users'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY workspace_rows ON %s USING (workspace_id = app.current_workspace_id()) WITH CHECK (workspace_id = app.current_workspace_id())', t);
  END LOOP;
  -- 고객사를 거쳐 워크스페이스가 정해지는 테이블. 정책 안의 customers 조회에도 RLS가 적용된다.
  FOREACH t IN ARRAY ARRAY['app.corporations', 'app.departments', 'app.user_corporations', 'app.user_scopes'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY workspace_rows ON %s USING (EXISTS (SELECT 1 FROM app.customers c WHERE c.id = customer_id)) WITH CHECK (EXISTS (SELECT 1 FROM app.customers c WHERE c.id = customer_id))', t);
  END LOOP;
  -- 사용자를 거쳐 워크스페이스가 정해지는 테이블
  FOREACH t IN ARRAY ARRAY['app.account_tokens', 'app.mail_outbox', 'app.idempotency_records'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY workspace_rows ON %s USING (EXISTS (SELECT 1 FROM app.users u WHERE u.id = user_id)) WITH CHECK (EXISTS (SELECT 1 FROM app.users u WHERE u.id = user_id))', t);
  END LOOP;
  -- 감사: 조회는 현재 워크스페이스만, 추가는 현재 워크스페이스 또는 미확인(NULL)만 허용
  FOREACH t IN ARRAY ARRAY['audit.audit_events', 'audit.audit_changes', 'audit.error_details'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY workspace_read ON %s FOR SELECT USING (workspace_id = app.current_workspace_id())', t);
    EXECUTE format('CREATE POLICY workspace_write ON %s FOR INSERT WITH CHECK (workspace_id IS NULL OR workspace_id = app.current_workspace_id())', t);
  END LOOP;
END $$;
ALTER TABLE app.responsibilities ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_rows ON app.responsibilities
  USING (workspace_id IS NULL OR workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id IS NULL OR workspace_id = app.current_workspace_id());

-- 로그인 전 공개 요청에서 워크스페이스를 찾는 조회. 소유자 권한으로 실행해 RLS 밖에서 필요한 값만 돌려준다.
-- 반환값은 워크스페이스 ID뿐이며 계정 정보는 이후 해당 워크스페이스 안에서 RLS를 적용해 다시 읽는다.
CREATE FUNCTION app.login_workspace(p_login text) RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app AS $$ SELECT workspace_id FROM app.users WHERE login_id = p_login $$;
CREATE FUNCTION app.signup_target(p_token text) RETURNS TABLE (workspace_id bigint, customer_id bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT c.workspace_id, c.id FROM app.customers c JOIN app.workspaces w ON w.id = c.workspace_id
  WHERE c.signup_token = p_token AND c.is_active AND w.status = 'ACTIVE' $$;
CREATE FUNCTION app.recovery_workspaces(p_email text) RETURNS SETOF bigint LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app AS $$
  SELECT DISTINCT workspace_id FROM app.users WHERE lower(email) = lower(p_email) ORDER BY 1 LIMIT 20 $$;
CREATE FUNCTION app.token_workspace(p_hash text) RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app AS $$
  SELECT u.workspace_id FROM app.account_tokens t JOIN app.users u ON u.id = t.user_id WHERE t.token_hash = p_hash $$;
CREATE FUNCTION app.platform_workspace_id() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app AS $$ SELECT id FROM app.workspaces WHERE is_platform $$;
-- 신규 업체 개설. 이후 셀프 가입 화면에서 사용한다. 운영 워크스페이스는 만들 수 없다.
CREATE FUNCTION app.create_workspace(p_code text, p_name text) RETURNS bigint LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, app AS $$ INSERT INTO app.workspaces (code, name) VALUES (p_code, p_name) RETURNING id $$;
COMMENT ON FUNCTION app.login_workspace(text) IS '로그인 ID의 워크스페이스 ID. 로그인 전 조회 전용(RLS 우회, ID만 반환).';
COMMENT ON FUNCTION app.signup_target(text) IS '가입 토큰의 워크스페이스·고객사 ID. 활성 고객사·워크스페이스만 반환.';
COMMENT ON FUNCTION app.recovery_workspaces(text) IS '이메일이 등록된 워크스페이스 ID 목록(최대 20). 계정 복구 요청 전용.';
COMMENT ON FUNCTION app.token_workspace(text) IS '일회용 계정 토큰 해시의 워크스페이스 ID. 토큰 사용 전용.';
COMMENT ON FUNCTION app.platform_workspace_id() IS '운영 워크스페이스 ID. 초기화 스크립트·테스트 전용.';
COMMENT ON FUNCTION app.create_workspace(text, text) IS '일반 워크스페이스 생성 후 ID 반환. 운영 여부는 항상 false.';
DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['app.login_workspace(text)', 'app.signup_target(text)', 'app.recovery_workspaces(text)',
    'app.token_workspace(text)', 'app.platform_workspace_id()', 'app.create_workspace(text,text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO doneline_app', f);
  END LOOP;
END $$;

-- security_invoker 뷰는 호출자에게 원본 테이블 조회 권한이 필요하다. 조회 범위는 위 RLS가 제한한다.
GRANT SELECT ON app.workspaces TO doneline_app;
GRANT SELECT ON audit.audit_events, audit.audit_changes TO doneline_app;

INSERT INTO public.schema_migrations (version) VALUES ('012_workspaces');
COMMIT;
