-- 업체별 SLA(첫 응답·처리 기한) 설정과 월간 리포트 화면.
-- 요청에 첫 응답 기한·첫 응답 시각을 추가해 응답 SLA 준수율을 계산할 수 있게 한다.
-- DB 소유자(관리 계정)로 실행한다.
BEGIN;

CREATE TABLE app.sla_policies (
  workspace_id bigint NOT NULL DEFAULT app.current_workspace_id() REFERENCES app.workspaces (id),
  priority text NOT NULL CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  response_hours integer NOT NULL CHECK (response_hours BETWEEN 1 AND 8760),
  resolve_hours integer NOT NULL CHECK (resolve_hours BETWEEN 1 AND 8760),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, priority),
  CHECK (response_hours <= resolve_hours)
);
CREATE TRIGGER row_version BEFORE UPDATE ON app.sla_policies FOR EACH ROW EXECUTE FUNCTION app.increment_row_version();
COMMENT ON TABLE app.sla_policies IS '워크스페이스별 우선순위 SLA. 행이 없는 우선순위는 앱 기본값(sla.ts)을 쓴다. 변경은 이후 등록되는 요청부터 적용.';
COMMENT ON COLUMN app.sla_policies.workspace_id IS '소유 워크스페이스(app.workspaces.id).';
COMMENT ON COLUMN app.sla_policies.priority IS '대상 우선순위 LOW/NORMAL/HIGH/URGENT.';
COMMENT ON COLUMN app.sla_policies.response_hours IS '첫 응답 기한(등록 후 시간, 1~8760). 처리 기한 이하. 달력 시간 기준(업무 시간 미적용).';
COMMENT ON COLUMN app.sla_policies.resolve_hours IS '처리 완료 기한(등록 후 시간, 1~8760). 달력 시간 기준.';
COMMENT ON COLUMN app.sla_policies.updated_at IS '마지막 변경 시각.';
COMMENT ON COLUMN app.sla_policies.version IS '동시 편집 충돌 검사용 행 버전.';
ALTER TABLE app.sla_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_rows ON app.sla_policies
  USING (workspace_id = app.current_workspace_id()) WITH CHECK (workspace_id = app.current_workspace_id());
GRANT SELECT, INSERT, UPDATE ON app.sla_policies TO doneline_app;

-- 기존 요청은 처리 기한과 같은 값으로 채워 NOT NULL을 맞춘다(과거 데이터에는 응답 기한 개념이 없었음).
ALTER TABLE app.service_requests ADD COLUMN response_due_at timestamptz;
UPDATE app.service_requests SET response_due_at = due_at;
ALTER TABLE app.service_requests ALTER COLUMN response_due_at SET NOT NULL;
ALTER TABLE app.service_requests ADD COLUMN first_response_at timestamptz;
COMMENT ON COLUMN app.service_requests.response_due_at IS '첫 응답 기한. 등록 시 워크스페이스 SLA(없으면 기본값)로 계산.';
COMMENT ON COLUMN app.service_requests.first_response_at IS '업체 담당자의 첫 응답 시각(고객에게 보이는 답변 또는 상태 변경). NULL=아직 응답 없음.';
COMMENT ON COLUMN app.service_requests.due_at IS '처리 기한. 등록 시 워크스페이스 SLA(없으면 기본값: 긴급 4시간, 높음 1일, 보통 3일, 낮음 7일)로 계산.';

-- 화면: SLA 설정(SAVE=저장), 월간 리포트(ETC1=엑셀 다운로드). 업체 관리자·운영 관리자 메뉴에 둔다.
INSERT INTO app.screens (code, name, purpose, component_key) VALUES
  ('SLA_SETTINGS', 'SLA 설정', '우선순위별 첫 응답·처리 기한', 'sla-settings'),
  ('SR_REPORT', '월간 리포트', '고객사별 요청 처리 실적과 엑셀 내보내기', 'sr-report')
  ON CONFLICT (code) DO NOTHING;
INSERT INTO app.screen_buttons (screen_id, action_code, label, is_used)
  SELECT s.id, a.code, CASE WHEN s.code = 'SR_REPORT' AND a.code = 'ETC1' THEN '엑셀 다운로드' ELSE a.label END,
    CASE WHEN a.code IN ('RESET', 'QUERY') THEN true
      WHEN s.code = 'SLA_SETTINGS' AND a.code = 'SAVE' THEN true
      WHEN s.code = 'SR_REPORT' AND a.code = 'ETC1' THEN true ELSE false END
  FROM app.screens s CROSS JOIN
  (VALUES ('RESET', '초기화'), ('QUERY', '조회'), ('SAVE', '저장'), ('DELETE', '삭제'),
    ('ETC1', '기타1'), ('ETC2', '기타2'), ('ETC3', '기타3'), ('ETC4', '기타4')) a (code, label)
  WHERE s.code IN ('SLA_SETTINGS', 'SR_REPORT') ON CONFLICT DO NOTHING;
INSERT INTO app.menu_screens (menu_id, screen_id, sort_order)
  SELECT m.id, s.id, CASE s.code WHEN 'SR_REPORT' THEN 2 ELSE 30 END FROM app.menus m
  JOIN app.screens s ON s.code IN ('SLA_SETTINGS', 'SR_REPORT')
  WHERE m.code IN ('WORKSPACE_ADMIN_ROOT', 'ROOT') ON CONFLICT DO NOTHING;
INSERT INTO app.menu_screen_buttons (menu_screen_id, action_code, is_allowed)
  SELECT ms.id, b.action_code, b.is_used FROM app.menu_screens ms
  JOIN app.screens s ON s.id = ms.screen_id JOIN app.screen_buttons b ON b.screen_id = s.id
  WHERE s.code IN ('SLA_SETTINGS', 'SR_REPORT') ON CONFLICT DO NOTHING;

INSERT INTO public.schema_migrations (version) VALUES ('015_sla_reports');
COMMIT;
