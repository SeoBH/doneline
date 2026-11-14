-- 고객 요청 첨부 파일. 장애 화면 캡처·로그·문서를 요청에 붙인다.
-- 파일 내용은 DB(bytea)에 둔다: 업체별 분리(행 수준 보안)와 DB 백업이 그대로 적용되기 때문이다.
-- 파일이 많아지면 외부 저장소(객체 저장소)로 옮기고 이 표에는 위치만 남긴다.
BEGIN;

CREATE TABLE app.request_attachments (
  id bigserial PRIMARY KEY,
  workspace_id bigint NOT NULL DEFAULT app.current_workspace_id() REFERENCES app.workspaces (id),
  request_id bigint NOT NULL REFERENCES app.service_requests (id) ON DELETE CASCADE,
  uploaded_by bigint NOT NULL REFERENCES app.users (id),
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200),
  content_type text NOT NULL CHECK (length(content_type) BETWEEN 1 AND 200),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  internal boolean NOT NULL DEFAULT false,
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX request_attachments_request_idx ON app.request_attachments (request_id, id);
ALTER TABLE app.request_attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_rows ON app.request_attachments
  USING (workspace_id = app.current_workspace_id()) WITH CHECK (workspace_id = app.current_workspace_id());
COMMENT ON TABLE app.request_attachments IS '고객 요청 첨부 파일. 추가만 하고 수정하지 않으며 요청 삭제 시 함께 삭제. 업체별 RLS 적용.';
COMMENT ON COLUMN app.request_attachments.workspace_id IS '소유 워크스페이스(app.workspaces.id). 기본값은 현재 트랜잭션의 워크스페이스.';
COMMENT ON COLUMN app.request_attachments.request_id IS '첨부한 요청(app.service_requests.id).';
COMMENT ON COLUMN app.request_attachments.uploaded_by IS '올린 사용자(app.users.id). 고객사 사용자 또는 업체 담당자.';
COMMENT ON COLUMN app.request_attachments.file_name IS '사용자가 올린 원래 파일 이름(경로·제어문자 제거, 1~200자). 내려받기 이름으로 쓴다.';
COMMENT ON COLUMN app.request_attachments.content_type IS '브라우저가 알려 준 파일 형식(MIME). 내려받기 때는 안전한 이미지 형식만 그대로 쓰고 나머지는 일반 파일로 내려준다.';
COMMENT ON COLUMN app.request_attachments.size_bytes IS '파일 크기(바이트). 1바이트~10MB.';
COMMENT ON COLUMN app.request_attachments.internal IS 'true=업체 내부용(고객 화면·고객 알림에서 제외). 기본 false. 고객이 올린 파일은 항상 false.';
COMMENT ON COLUMN app.request_attachments.data IS '파일 내용(바이트).';
COMMENT ON COLUMN app.request_attachments.created_at IS '올린 시각.';
GRANT SELECT, INSERT ON app.request_attachments TO doneline_app;
GRANT USAGE, SELECT ON SEQUENCE app.request_attachments_id_seq TO doneline_app;

-- 처리 이력에 '파일 첨부'를 남길 수 있게 이력 종류를 넓힌다.
ALTER TABLE app.request_events DROP CONSTRAINT request_events_kind_check;
ALTER TABLE app.request_events ADD CONSTRAINT request_events_kind_check
  CHECK (kind IN ('CREATED', 'COMMENT', 'STATUS', 'ASSIGN', 'PRIORITY', 'ATTACH'));
COMMENT ON COLUMN app.request_events.kind IS 'CREATED/COMMENT/STATUS/ASSIGN/PRIORITY/ATTACH(파일 첨부, body=파일 이름).';

INSERT INTO public.schema_migrations (version) VALUES ('021_request_attachments');
COMMIT;
