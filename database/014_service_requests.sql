-- 고객 요청(SR) 접수·처리. 고객사 사용자가 요청을 등록하고 업체 담당자가 배정·처리하며 고객이 완료를 확인한다.
-- 모든 표는 workspace_id를 직접 가지며 행 수준 보안(RLS)으로 다른 업체의 요청을 숨긴다.
-- 고객사 사용자의 조회 범위(본인 법인·부서 매핑)는 앱(requests.ts)에서 추가로 제한한다.
-- DB 소유자(관리 계정)로 실행한다.
BEGIN;

CREATE TABLE app.service_requests (
  id bigserial PRIMARY KEY,
  workspace_id bigint NOT NULL DEFAULT app.current_workspace_id() REFERENCES app.workspaces (id),
  request_no integer NOT NULL CHECK (request_no > 0),
  customer_id bigint NOT NULL,
  corporation_id bigint NOT NULL,
  department_id bigint NOT NULL,
  requester_id bigint NOT NULL REFERENCES app.users (id),
  assignee_id bigint REFERENCES app.users (id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  category text NOT NULL DEFAULT 'REQUEST' CHECK (category IN ('INCIDENT', 'REQUEST', 'QUESTION')),
  priority text NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'CANCELLED')),
  due_at timestamptz NOT NULL,
  resolved_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, request_no),
  -- 요청의 고객사는 같은 워크스페이스의 고객사여야 하고, 부서는 그 고객사·법인의 실제 부서여야 한다.
  FOREIGN KEY (customer_id, workspace_id) REFERENCES app.customers (id, workspace_id),
  FOREIGN KEY (customer_id, corporation_id, department_id) REFERENCES app.departments (customer_id, corporation_id, id)
);
CREATE INDEX service_requests_list_idx ON app.service_requests (workspace_id, status, updated_at DESC);
CREATE INDEX service_requests_customer_idx ON app.service_requests (customer_id, corporation_id, department_id);
CREATE TRIGGER row_version BEFORE UPDATE ON app.service_requests FOR EACH ROW EXECUTE FUNCTION app.increment_row_version();
COMMENT ON TABLE app.service_requests IS '고객 요청(SR). 고객사 사용자가 등록하고 업체 담당자가 처리한다.';
COMMENT ON COLUMN app.service_requests.workspace_id IS '소유 워크스페이스(app.workspaces.id). 기본값은 현재 트랜잭션의 워크스페이스.';
COMMENT ON COLUMN app.service_requests.request_no IS '워크스페이스 안의 요청 번호(1부터 증가). 화면 표시용 #번호.';
COMMENT ON COLUMN app.service_requests.customer_id IS '요청 고객사(app.customers.id). 요청자의 고객사.';
COMMENT ON COLUMN app.service_requests.corporation_id IS '요청 법인(app.corporations.id). 요청자 매핑 범위 안에서 선택.';
COMMENT ON COLUMN app.service_requests.department_id IS '요청 부서(app.departments.id). 고객사 사용자 조회 범위 판단 기준.';
COMMENT ON COLUMN app.service_requests.requester_id IS '등록한 고객사 사용자(app.users.id).';
COMMENT ON COLUMN app.service_requests.assignee_id IS '처리 담당자(app.users.id, SYSTEM 계정). NULL=미배정.';
COMMENT ON COLUMN app.service_requests.title IS '요청 제목(1~200자).';
COMMENT ON COLUMN app.service_requests.body IS '요청 내용(1~10000자).';
COMMENT ON COLUMN app.service_requests.category IS 'INCIDENT=장애, REQUEST=작업 요청, QUESTION=문의. 기본 REQUEST.';
COMMENT ON COLUMN app.service_requests.priority IS 'LOW/NORMAL/HIGH/URGENT. 기본 NORMAL. 처리 기한 계산에 사용.';
COMMENT ON COLUMN app.service_requests.status IS 'OPEN=접수, IN_PROGRESS=처리 중, RESOLVED=처리 완료(고객 확인 대기), CLOSED=고객 확인 종료, CANCELLED=취소.';
COMMENT ON COLUMN app.service_requests.due_at IS '처리 기한(SLA). 등록 시 우선순위로 계산: 긴급 4시간, 높음 1일, 보통 3일, 낮음 7일.';
COMMENT ON COLUMN app.service_requests.resolved_at IS '담당자가 처리 완료로 바꾼 시각. 재처리로 돌아가면 NULL.';
COMMENT ON COLUMN app.service_requests.closed_at IS '고객 확인 또는 취소로 종료된 시각.';
COMMENT ON COLUMN app.service_requests.created_at IS '등록 시각.';
COMMENT ON COLUMN app.service_requests.updated_at IS '마지막 변경 시각(댓글 포함). 목록 정렬 기준.';
COMMENT ON COLUMN app.service_requests.version IS '동시 편집 충돌 검사용 행 버전. 변경마다 트리거가 1 증가.';

CREATE TABLE app.request_events (
  id bigserial PRIMARY KEY,
  workspace_id bigint NOT NULL DEFAULT app.current_workspace_id() REFERENCES app.workspaces (id),
  request_id bigint NOT NULL REFERENCES app.service_requests (id) ON DELETE CASCADE,
  actor_id bigint NOT NULL REFERENCES app.users (id),
  kind text NOT NULL CHECK (kind IN ('CREATED', 'COMMENT', 'STATUS', 'ASSIGN', 'PRIORITY')),
  body text CHECK (body IS NULL OR length(body) BETWEEN 1 AND 10000),
  from_value text,
  to_value text,
  internal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX request_events_request_idx ON app.request_events (request_id, id);
COMMENT ON TABLE app.request_events IS '요청 처리 이력(등록·댓글·상태·담당자·우선순위 변경). 수정·삭제하지 않고 추가만 한다.';
COMMENT ON COLUMN app.request_events.workspace_id IS '소유 워크스페이스. 요청과 같은 값.';
COMMENT ON COLUMN app.request_events.request_id IS '대상 요청(app.service_requests.id).';
COMMENT ON COLUMN app.request_events.actor_id IS '작성·변경한 사용자(app.users.id).';
COMMENT ON COLUMN app.request_events.kind IS 'CREATED/COMMENT/STATUS/ASSIGN/PRIORITY.';
COMMENT ON COLUMN app.request_events.body IS '댓글 본문. 변경 이력은 NULL일 수 있음.';
COMMENT ON COLUMN app.request_events.from_value IS '변경 전 값(상태 코드·담당자 ID·우선순위). 댓글은 NULL.';
COMMENT ON COLUMN app.request_events.to_value IS '변경 후 값. 댓글은 NULL.';
COMMENT ON COLUMN app.request_events.internal IS 'true=업체 내부 메모(고객에게 보이지 않음). 기본 false.';
COMMENT ON COLUMN app.request_events.created_at IS '기록 시각.';

CREATE TABLE app.notifications (
  id bigserial PRIMARY KEY,
  workspace_id bigint NOT NULL DEFAULT app.current_workspace_id() REFERENCES app.workspaces (id),
  user_id bigint NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  request_id bigint REFERENCES app.service_requests (id) ON DELETE CASCADE,
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 300),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON app.notifications (user_id, read_at, id DESC);
COMMENT ON TABLE app.notifications IS '앱 안 알림(화면 상단 종 아이콘). 외부 발송 없이 DB에만 저장.';
COMMENT ON COLUMN app.notifications.workspace_id IS '소유 워크스페이스.';
COMMENT ON COLUMN app.notifications.user_id IS '받는 사용자(app.users.id).';
COMMENT ON COLUMN app.notifications.request_id IS '관련 요청(app.service_requests.id). 없으면 NULL.';
COMMENT ON COLUMN app.notifications.message IS '알림 문구(1~300자).';
COMMENT ON COLUMN app.notifications.read_at IS '읽은 시각. NULL=안 읽음.';
COMMENT ON COLUMN app.notifications.created_at IS '생성 시각.';

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['app.service_requests', 'app.request_events', 'app.notifications'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY workspace_rows ON %s USING (workspace_id = app.current_workspace_id()) WITH CHECK (workspace_id = app.current_workspace_id())', t);
  END LOOP;
END $$;
-- 처리 이력은 추가만 한다. 수정·삭제 권한을 주지 않는다.
GRANT SELECT, INSERT, UPDATE ON app.service_requests TO doneline_app;
GRANT SELECT, INSERT ON app.request_events TO doneline_app;
GRANT SELECT, INSERT, UPDATE ON app.notifications TO doneline_app;
GRANT USAGE, SELECT ON SEQUENCE app.service_requests_id_seq, app.request_events_id_seq, app.notifications_id_seq TO doneline_app;

-- 화면: 고객 요청(고객사 사용자용)과 요청 작업함(업체 담당자용).
INSERT INTO app.screens (code, name, purpose, component_key) VALUES
  ('SR_PORTAL', '고객 요청', '고객사 사용자의 요청 등록·확인', 'sr-portal'),
  ('SR_DESK', '요청 작업함', '업체 담당자의 요청 배정·처리', 'sr-desk')
  ON CONFLICT (code) DO NOTHING;
-- SR_PORTAL: SAVE=요청 등록·댓글, ETC1=완료 확인. SR_DESK: SAVE=상태·담당자·우선순위·댓글 저장.
INSERT INTO app.screen_buttons (screen_id, action_code, label, is_used)
  SELECT s.id, a.code, a.label, u.used FROM app.screens s CROSS JOIN
  (VALUES ('RESET', '초기화'), ('QUERY', '조회'), ('SAVE', '저장'), ('DELETE', '삭제'),
    ('ETC1', '완료 확인'), ('ETC2', '기타2'), ('ETC3', '기타3'), ('ETC4', '기타4')) a (code, label)
  CROSS JOIN LATERAL (SELECT CASE WHEN a.code IN ('RESET', 'QUERY', 'SAVE') THEN true
    WHEN s.code = 'SR_PORTAL' AND a.code = 'ETC1' THEN true ELSE false END AS used) u (used)
  WHERE s.code IN ('SR_PORTAL', 'SR_DESK') ON CONFLICT DO NOTHING;
UPDATE app.screen_buttons SET label = '기타1'
  WHERE action_code = 'ETC1' AND screen_id = (SELECT id FROM app.screens WHERE code = 'SR_DESK');

-- 업체 담당자 전용 RESP: 요청 작업함만 사용한다(관리 화면 없음).
INSERT INTO app.menus (code, name) VALUES ('WORKSPACE_ENGINEER_ROOT', '요청 처리') ON CONFLICT (code) DO NOTHING;
INSERT INTO app.responsibilities (code, name, root_menu_id, authority_type, level)
  SELECT 'WORKSPACE_ENGINEER', '업체 담당자', id, 'SYSTEM', 20 FROM app.menus WHERE code = 'WORKSPACE_ENGINEER_ROOT'
  ON CONFLICT (code) DO NOTHING;
-- 메뉴 배치: 작업함은 업체 관리자·업체 담당자·운영 관리자, 고객 요청은 고객사 관리자·고객사 사용자 메뉴에 둔다.
INSERT INTO app.menu_screens (menu_id, screen_id, sort_order)
  SELECT m.id, s.id, 1 FROM app.menus m JOIN app.screens s ON
    (s.code = 'SR_DESK' AND m.code IN ('WORKSPACE_ADMIN_ROOT', 'WORKSPACE_ENGINEER_ROOT', 'ROOT'))
    OR (s.code = 'SR_PORTAL' AND m.code IN ('CUSTOMER_ADMIN_ROOT', 'CUSTOMER_USER_ROOT'))
  ON CONFLICT DO NOTHING;
INSERT INTO app.menu_screen_buttons (menu_screen_id, action_code, is_allowed)
  SELECT ms.id, b.action_code, b.is_used FROM app.menu_screens ms
  JOIN app.screens s ON s.id = ms.screen_id JOIN app.screen_buttons b ON b.screen_id = s.id
  WHERE s.code IN ('SR_PORTAL', 'SR_DESK') ON CONFLICT DO NOTHING;

INSERT INTO public.schema_migrations (version) VALUES ('014_service_requests');
COMMIT;
