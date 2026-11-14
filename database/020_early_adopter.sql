-- 초기 업체 내부 기록. 셀프 가입한 업체 중 처음 30곳을 표시해 두고, 나중에 유료 요금제를 도입할 때
-- 이 업체들은 그 시점에 제공하던 기능을 계속 무료로 쓰게 하는 근거로 쓴다(CEO 결정, 2026-11-14).
-- 외부(소개 페이지·앱 화면)에는 공개하지 않는 내부 기준이다. 기준 수를 바꾸려면 아래 함수의 30을 바꾼다.
BEGIN;

ALTER TABLE app.workspaces ADD COLUMN early_adopter boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN app.workspaces.early_adopter IS 'true=셀프 가입 순서로 처음 30곳 안에 든 초기 업체(내부 기준, 화면 비공개). 유료화 시 당시 제공 기능 무료 유지 대상. 기본 false(운영 워크스페이스·이 마이그레이션 이전 업체 포함).';

-- 업체 개설 함수에 초기 업체 판정을 넣는다. 반환값(업체 ID)과 사용법은 그대로다.
CREATE OR REPLACE FUNCTION app.create_workspace(p_code text, p_name text) RETURNS bigint LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, app AS $$
DECLARE
  v_id bigint;
  v_early boolean;
BEGIN
  -- 두 업체가 동시에 가입해도 30곳을 넘기지 않도록 이 판정을 한 번에 하나씩 실행한다(트랜잭션이 끝나면 자동 해제).
  PERFORM pg_advisory_xact_lock(hashtext('app.create_workspace.early_adopter'));
  SELECT count(*) < 30 INTO v_early FROM app.workspaces WHERE early_adopter;
  INSERT INTO app.workspaces (code, name, early_adopter) VALUES (p_code, p_name, v_early) RETURNING id INTO v_id;
  RETURN v_id;
END $$;
COMMENT ON FUNCTION app.create_workspace(text, text) IS '일반 워크스페이스 생성 후 ID 반환. 운영 여부는 항상 false. 초기 업체(처음 30곳)이면 early_adopter=true로 기록.';

-- 초기 업체로 기록된 수. 운영 슬랙의 가입 알림(몇 번째 초기 업체인지)과 테스트에서 쓴다. 숫자만 돌려준다.
CREATE FUNCTION app.early_adopter_count() RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app AS $$ SELECT count(*)::int FROM app.workspaces WHERE early_adopter $$;
REVOKE ALL ON FUNCTION app.early_adopter_count() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.early_adopter_count() TO doneline_app;
COMMENT ON FUNCTION app.early_adopter_count() IS '초기 업체(early_adopter)로 기록된 워크스페이스 수. 운영 알림·테스트 전용(RLS 우회, 숫자만 반환).';

INSERT INTO public.schema_migrations (version) VALUES ('020_early_adopter');
COMMIT;
