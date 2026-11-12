-- 이메일 인증·최초 비밀번호 설정·계정 복구. 기존 비밀번호와 로그인 조건은 보존한다.
BEGIN;
ALTER TABLE app.users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE app.users ADD COLUMN email text;
ALTER TABLE app.users ADD COLUMN email_verified_at timestamptz;
ALTER TABLE app.users ADD CONSTRAINT users_email_verified CHECK(email_verified_at IS NULL OR email IS NOT NULL);
CREATE INDEX users_email_idx ON app.users(lower(email));
CREATE TABLE app.account_tokens (
 token_hash text PRIMARY KEY,
 user_id bigint NOT NULL REFERENCES app.users ON DELETE CASCADE,
 purpose text NOT NULL CHECK(purpose IN ('VERIFY','PASSWORD')),
 email text NOT NULL,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_tokens_user_idx ON app.account_tokens(user_id);
CREATE TABLE app.mail_outbox (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id bigint NOT NULL REFERENCES app.users ON DELETE CASCADE,
 payload text NOT NULL,
 status text NOT NULL DEFAULT 'HELD' CHECK(status IN ('HELD','CANCELLED')),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
-- 사용자 정보 변경과 동시에 이전 주소/권한으로 발급된 링크를 폐기한다.
CREATE FUNCTION app.invalidate_account_tokens() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$
BEGIN
 IF NEW.email IS DISTINCT FROM OLD.email THEN NEW.email_verified_at=NULL; END IF;
 IF NEW.email IS DISTINCT FROM OLD.email OR NEW.password_hash IS DISTINCT FROM OLD.password_hash
 OR NEW.customer_id IS DISTINCT FROM OLD.customer_id OR NEW.account_status IS DISTINCT FROM OLD.account_status
 OR NEW.is_active IS DISTINCT FROM OLD.is_active OR NEW.resp_id IS DISTINCT FROM OLD.resp_id THEN
  DELETE FROM app.account_tokens WHERE user_id=OLD.id;
  UPDATE app.mail_outbox SET status='CANCELLED',payload='' WHERE user_id=OLD.id AND status='HELD';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER invalidate_account_tokens BEFORE UPDATE ON app.users FOR EACH ROW EXECUTE FUNCTION app.invalidate_account_tokens();
COMMENT ON COLUMN app.users.password_hash IS 'Argon2 비밀번호 해시. NULL은 관리자 등록 후 최초 비밀번호 미설정으로 로그인 불가. 원문 저장 금지.';
COMMENT ON COLUMN app.users.email IS '계정 복구 이메일. 소문자 정규화하며 NULL은 기존 계정의 미등록 상태. 중복 주소는 허용.';
COMMENT ON COLUMN app.users.email_verified_at IS '이메일 소유 확인 시각. NULL은 미인증이며 사용자 직접 아이디 찾기·비밀번호 재설정 대상에서 제외.';
COMMENT ON TABLE app.account_tokens IS '메일 링크용 일회용 토큰의 SHA-256 해시. 사용·재발급·계정 변경 시 폐기.';
COMMENT ON COLUMN app.account_tokens.token_hash IS '암호학적 난수 32바이트 토큰의 SHA-256 해시. 원문은 저장하지 않음.';
COMMENT ON COLUMN app.account_tokens.user_id IS '대상 사용자 ID. 사용자 삭제 시 함께 삭제.';
COMMENT ON COLUMN app.account_tokens.purpose IS 'VERIFY 이메일 소유 확인, PASSWORD 최초 설정 또는 재설정. 용도 간 교차 사용 금지.';
COMMENT ON COLUMN app.account_tokens.email IS '발급 당시 이메일. 현재 사용자 이메일과 일치해야 사용 가능.';
COMMENT ON COLUMN app.account_tokens.expires_at IS '링크 만료 시각. 발급 후 30분.';
COMMENT ON COLUMN app.account_tokens.created_at IS '발급 시각. 기본값 현재 시각.';
COMMENT ON TABLE app.mail_outbox IS '실제 발송 연동 전 보류 메일. 개발용 CLI에서만 복호화하며 공개 API에 링크를 반환하지 않음.';
COMMENT ON COLUMN app.mail_outbox.id IS '자동 생성 메일 ID.';
COMMENT ON COLUMN app.mail_outbox.user_id IS '수신 사용자 ID. 계정 삭제 시 함께 삭제.';
COMMENT ON COLUMN app.mail_outbox.payload IS '수신 주소·제목·본문의 AES-256-GCM 암호문. 취소 시 빈 문자열로 제거.';
COMMENT ON COLUMN app.mail_outbox.status IS 'HELD 발송 보류(기본값), CANCELLED 링크 폐기. 실제 발송 완료를 뜻하는 상태는 아직 없음.';
COMMENT ON COLUMN app.mail_outbox.expires_at IS '메일 내용 확인 가능 기한. 만료 메일은 발송·미리보기 대상에서 제외.';
COMMENT ON COLUMN app.mail_outbox.created_at IS '작성 시각. 기본값 현재 시각.';
GRANT SELECT,INSERT,UPDATE,DELETE ON app.account_tokens,app.mail_outbox TO doneline_app;
GRANT USAGE,SELECT ON SEQUENCE app.mail_outbox_id_seq TO doneline_app;
INSERT INTO public.schema_migrations(version) VALUES('010_email_recovery');
COMMIT;
