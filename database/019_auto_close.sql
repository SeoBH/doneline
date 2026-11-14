-- 확인 대기 자동 완료. 담당자가 처리 완료(RESOLVED)한 뒤 고객이 정해진 기간(현재 7일) 동안 확인하지 않으면
-- 서버가 완료(CLOSED)로 바꾼다. 자동 완료와 고객 확인 완료를 리포트에서 구분하도록 표시 컬럼을 둔다.
-- 서버 작업은 로그인 요청 밖에서 실행되므로, 대상 요청이 있는 워크스페이스 ID만 돌려주는 함수를 둔다.
BEGIN;

ALTER TABLE app.service_requests ADD COLUMN auto_closed boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN app.service_requests.auto_closed IS 'true=고객 확인 없이 확인 기간이 지나 서버가 자동으로 완료(CLOSED)한 요청. 기본 false(고객 확인·취소·진행 중).';
COMMENT ON COLUMN app.service_requests.closed_at IS '고객 확인, 확인 기간 경과 자동 완료, 또는 취소로 종료된 시각.';
-- 확인 대기 요청을 처리 완료 시각 순으로 찾는 부분 색인(자동 완료 대상 조회용).
CREATE INDEX service_requests_resolved_idx ON app.service_requests (resolved_at) WHERE status = 'RESOLVED';

-- 서버 자동 처리 이력은 작성자가 없다.
ALTER TABLE app.request_events ALTER COLUMN actor_id DROP NOT NULL;
COMMENT ON COLUMN app.request_events.actor_id IS '작성·변경한 사용자(app.users.id). NULL=서버 자동 처리(확인 기간 경과 자동 완료 등).';

CREATE FUNCTION app.auto_close_workspaces(p_days integer) RETURNS SETOF bigint LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app AS $$
  SELECT DISTINCT workspace_id FROM app.service_requests
  WHERE status = 'RESOLVED' AND resolved_at <= now() - make_interval(days => p_days) ORDER BY 1 LIMIT 500 $$;
REVOKE ALL ON FUNCTION app.auto_close_workspaces(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.auto_close_workspaces(integer) TO doneline_app;
COMMENT ON FUNCTION app.auto_close_workspaces(integer) IS '처리 완료 후 p_days일 넘게 고객 확인이 없는 요청이 있는 워크스페이스 ID(최대 500). 자동 완료 작업 전용(RLS 우회, ID만 반환).';

INSERT INTO public.schema_migrations (version) VALUES ('019_auto_close');
COMMIT;
