-- 개선 요청(제품 피드백). 모든 워크스페이스의 사용자가 앱 안에서 Doneline 운영팀에 보내고,
-- 운영 워크스페이스만 목록을 보고 처리 상태를 바꾼다. 작성 업체·작성자 이름은 작성 시점 값을 복사해 둔다
-- (운영 워크스페이스는 RLS 때문에 다른 업체의 사용자 표를 읽을 수 없기 때문).
-- DB 소유자(관리 계정)로 실행한다.
BEGIN;

CREATE TABLE app.feedback (
  id bigserial PRIMARY KEY,
  workspace_id bigint NOT NULL DEFAULT app.current_workspace_id() REFERENCES app.workspaces (id),
  user_id bigint REFERENCES app.users (id) ON DELETE SET NULL,
  workspace_name text NOT NULL,
  user_name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('IMPROVEMENT', 'BUG', 'QUESTION')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  page text CHECK (page IS NULL OR length(page) <= 200),
  status text NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'REVIEWED', 'PLANNED', 'DONE', 'DECLINED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE INDEX feedback_status_idx ON app.feedback (status, created_at DESC);
CREATE TRIGGER row_version BEFORE UPDATE ON app.feedback FOR EACH ROW EXECUTE FUNCTION app.increment_row_version();
COMMENT ON TABLE app.feedback IS '앱 안 개선 요청(제품 피드백). 작성은 모든 워크스페이스, 조회·처리는 운영 워크스페이스만.';
COMMENT ON COLUMN app.feedback.workspace_id IS '작성한 사용자의 워크스페이스(app.workspaces.id).';
COMMENT ON COLUMN app.feedback.user_id IS '작성자(app.users.id). 사용자 삭제 시 NULL.';
COMMENT ON COLUMN app.feedback.workspace_name IS '작성 시점 업체명(표시용 복사본).';
COMMENT ON COLUMN app.feedback.user_name IS '작성 시점 작성자 이름(표시용 복사본).';
COMMENT ON COLUMN app.feedback.kind IS 'IMPROVEMENT=개선 제안, BUG=오류 신고, QUESTION=문의.';
COMMENT ON COLUMN app.feedback.title IS '제목(1~200자).';
COMMENT ON COLUMN app.feedback.body IS '내용(1~5000자).';
COMMENT ON COLUMN app.feedback.page IS '작성 당시 보고 있던 화면 이름. 없으면 NULL.';
COMMENT ON COLUMN app.feedback.status IS 'NEW=접수, REVIEWED=검토함, PLANNED=반영 예정, DONE=반영 완료, DECLINED=반영 안 함. 기본 NEW.';
COMMENT ON COLUMN app.feedback.created_at IS '작성 시각.';
COMMENT ON COLUMN app.feedback.updated_at IS '마지막 상태 변경 시각.';
COMMENT ON COLUMN app.feedback.version IS '동시 편집 충돌 검사용 행 버전.';

ALTER TABLE app.feedback ENABLE ROW LEVEL SECURITY;
-- 작성: 자기 워크스페이스 이름으로만. 조회·변경: 운영 워크스페이스에서만.
-- (작성자는 자기 글을 다시 읽지 않으므로 INSERT 때 RETURNING을 쓰지 않는다.)
CREATE POLICY feedback_write ON app.feedback FOR INSERT
  WITH CHECK (workspace_id = app.current_workspace_id());
CREATE POLICY feedback_platform_read ON app.feedback FOR SELECT
  USING (app.current_workspace_id() = app.platform_workspace_id());
CREATE POLICY feedback_platform_update ON app.feedback FOR UPDATE
  USING (app.current_workspace_id() = app.platform_workspace_id());
GRANT SELECT, INSERT, UPDATE ON app.feedback TO doneline_app;
GRANT USAGE, SELECT ON SEQUENCE app.feedback_id_seq TO doneline_app;

-- 운영 화면: 개선 요청 수신함(QUERY=조회, SAVE=상태 저장). 운영 관리자(ROOT) 메뉴에만 둔다.
INSERT INTO app.screens (code, name, purpose, component_key)
  VALUES ('FEEDBACK_INBOX', '개선 요청 수신함', '사용자 개선 요청 확인·처리 상태 관리', 'feedback-inbox')
  ON CONFLICT (code) DO NOTHING;
INSERT INTO app.screen_buttons (screen_id, action_code, label, is_used)
  SELECT s.id, a.code, a.label, a.code IN ('RESET', 'QUERY', 'SAVE') FROM app.screens s CROSS JOIN
  (VALUES ('RESET', '초기화'), ('QUERY', '조회'), ('SAVE', '저장'), ('DELETE', '삭제'),
    ('ETC1', '기타1'), ('ETC2', '기타2'), ('ETC3', '기타3'), ('ETC4', '기타4')) a (code, label)
  WHERE s.code = 'FEEDBACK_INBOX' ON CONFLICT DO NOTHING;
INSERT INTO app.menu_screens (menu_id, screen_id, sort_order)
  SELECT m.id, s.id, 95 FROM app.menus m JOIN app.screens s ON s.code = 'FEEDBACK_INBOX'
  WHERE m.code = 'ROOT' ON CONFLICT DO NOTHING;
INSERT INTO app.menu_screen_buttons (menu_screen_id, action_code, is_allowed)
  SELECT ms.id, b.action_code, b.is_used FROM app.menu_screens ms
  JOIN app.screens s ON s.id = ms.screen_id JOIN app.screen_buttons b ON b.screen_id = s.id
  WHERE s.code = 'FEEDBACK_INBOX' ON CONFLICT DO NOTHING;

INSERT INTO public.schema_migrations (version) VALUES ('016_feedback');
COMMIT;
