-- 메일 실제 발송. 보류 메일함(mail_outbox)을 발송 대기열로 쓰고 발송 결과·재시도 정보를 기록한다.
-- 계정 메일(ACCOUNT: 인증·비밀번호 링크)에 더해 고객 요청 업무 메일(REQUEST)을 같은 대기열로 보낸다.
-- 발송기는 로그인 요청 밖에서 실행되므로, 발송할 메일이 있는 워크스페이스 ID만 돌려주는 함수를 둔다.
BEGIN;

ALTER TABLE app.mail_outbox DROP CONSTRAINT mail_outbox_status_check;
ALTER TABLE app.mail_outbox ADD CONSTRAINT mail_outbox_status_check
  CHECK (status IN ('HELD', 'SENT', 'FAILED', 'CANCELLED'));
ALTER TABLE app.mail_outbox
  ADD COLUMN kind text NOT NULL DEFAULT 'ACCOUNT' CHECK (kind IN ('ACCOUNT', 'REQUEST')),
  ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN sent_at timestamptz,
  ADD COLUMN last_error text;
-- 발송기가 매번 찾는 '보낼 차례가 된 대기 메일'만 담는 부분 색인.
CREATE INDEX mail_outbox_due ON app.mail_outbox (next_attempt_at) WHERE status = 'HELD';

-- 계정 정보가 바뀌면 이전 링크 메일은 계속 폐기한다. 업무 메일은 받는 주소가 바뀌거나 계정을 쓸 수 없게 된 경우만 폐기한다
-- (비밀번호 변경·RESP 변경만으로 요청 알림을 지우지 않는다).
CREATE OR REPLACE FUNCTION app.invalidate_account_tokens() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$
BEGIN
 IF NEW.email IS DISTINCT FROM OLD.email THEN NEW.email_verified_at=NULL; END IF;
 IF NEW.email IS DISTINCT FROM OLD.email OR NEW.password_hash IS DISTINCT FROM OLD.password_hash
 OR NEW.customer_id IS DISTINCT FROM OLD.customer_id OR NEW.account_status IS DISTINCT FROM OLD.account_status
 OR NEW.is_active IS DISTINCT FROM OLD.is_active OR NEW.resp_id IS DISTINCT FROM OLD.resp_id THEN
  DELETE FROM app.account_tokens WHERE user_id=OLD.id;
  UPDATE app.mail_outbox SET status='CANCELLED',payload='' WHERE user_id=OLD.id AND status='HELD' AND kind='ACCOUNT';
 END IF;
 IF NEW.email IS DISTINCT FROM OLD.email OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
 OR NEW.account_status IS DISTINCT FROM OLD.account_status OR NEW.is_active IS DISTINCT FROM OLD.is_active THEN
  UPDATE app.mail_outbox SET status='CANCELLED',payload='' WHERE user_id=OLD.id AND status='HELD' AND kind='REQUEST';
 END IF;
 RETURN NEW;
END $$;

-- 발송기 전용. RLS 밖에서 '보낼 차례인 메일이 있는 워크스페이스 ID'만 돌려주고, 메일 내용은 각 워크스페이스 범위 안에서 다시 읽는다.
CREATE FUNCTION app.mail_due_workspaces() RETURNS SETOF bigint LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app AS $$
  SELECT DISTINCT u.workspace_id FROM app.mail_outbox m JOIN app.users u ON u.id = m.user_id
  WHERE m.status = 'HELD' AND m.next_attempt_at <= now() AND m.expires_at > now() ORDER BY 1 LIMIT 100 $$;
REVOKE ALL ON FUNCTION app.mail_due_workspaces() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.mail_due_workspaces() TO doneline_app;

COMMENT ON TABLE app.mail_outbox IS '메일 발송 대기열과 결과. 내용은 암호화하며 발송 완료·실패·취소 후에는 내용을 지움. SMTP 미설정이면 HELD로 남고 개발용 CLI로만 확인.';
COMMENT ON COLUMN app.mail_outbox.status IS 'HELD 발송 대기(기본값), SENT 발송 완료, FAILED 재시도 한도 초과로 중단, CANCELLED 링크 폐기·수신 계정 변경.';
COMMENT ON COLUMN app.mail_outbox.payload IS '수신 주소·제목·본문의 AES-256-GCM 암호문. 발송 완료·실패·취소 시 빈 문자열로 제거.';
COMMENT ON COLUMN app.mail_outbox.expires_at IS '발송 가능 기한. 지나면 발송·미리보기 대상에서 제외(계정 링크는 링크 유효 시간, 업무 메일은 24시간).';
COMMENT ON COLUMN app.mail_outbox.kind IS 'ACCOUNT 계정 메일(이메일 인증·비밀번호 설정·아이디 안내), REQUEST 고객 요청 업무 메일. 기본 ACCOUNT.';
COMMENT ON COLUMN app.mail_outbox.attempts IS '발송 시도 횟수. 기본 0이며 5회 실패하면 FAILED로 중단.';
COMMENT ON COLUMN app.mail_outbox.next_attempt_at IS '다음 발송 시도 가능 시각. 기본 작성 시각. 발송 중에는 5분 뒤로 미뤄 중복 발송을 막고, 실패 시 1·5·15·60분 간격으로 미룸.';
COMMENT ON COLUMN app.mail_outbox.sent_at IS '메일 서버가 접수한 시각. NULL은 미발송.';
COMMENT ON COLUMN app.mail_outbox.last_error IS '마지막 발송 실패 코드(예: EAUTH, ECONNECTION, SMTP 550). 주소·본문 같은 개인정보는 넣지 않음. NULL은 실패 없음.';
COMMENT ON FUNCTION app.mail_due_workspaces() IS '발송할 대기 메일이 있는 워크스페이스 ID 목록(최대 100). 메일 발송기 전용(RLS 우회, ID만 반환).';

INSERT INTO public.schema_migrations (version) VALUES ('018_mail_delivery');
COMMIT;
