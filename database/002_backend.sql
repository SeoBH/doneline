-- 로그인 전 세션과 로그인 제한 저장소를 추가한다. 비밀번호·RESP·활성 상태 변경 시 사용자 세션을 폐기하고 안전한 감사 요약 뷰를 제공한다.
BEGIN;
ALTER TABLE app.auth_sessions ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE app.auth_sessions ADD COLUMN IF NOT EXISTS session_data jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS app.login_limits (
  bucket text PRIMARY KEY,
  attempts integer NOT NULL,
  expires_at timestamptz NOT NULL
);
GRANT SELECT,INSERT,UPDATE,DELETE ON app.login_limits TO doneline_app;
CREATE OR REPLACE FUNCTION app.revoke_user_sessions() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$
BEGIN
 IF NEW.password_hash IS DISTINCT FROM OLD.password_hash OR NEW.resp_id IS DISTINCT FROM OLD.resp_id OR NEW.is_active IS DISTINCT FROM OLD.is_active THEN
 UPDATE app.auth_sessions SET revoked_at=now() WHERE user_id=NEW.id AND revoked_at IS NULL;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS revoke_changed_user ON app.users;
CREATE TRIGGER revoke_changed_user AFTER UPDATE ON app.users FOR EACH ROW EXECUTE FUNCTION app.revoke_user_sessions();
-- App can read safe audit metadata. Technical stacks and before/after values stay restricted.
CREATE OR REPLACE VIEW audit.event_summary AS SELECT event_id,request_id,occurred_at,user_id,resp_id,menu_id,screen_id,action,phase,outcome,error_code,safe_message FROM audit.audit_events;
GRANT SELECT ON audit.event_summary TO doneline_app;
INSERT INTO public.schema_migrations(version) VALUES('002_backend') ON CONFLICT DO NOTHING;
COMMIT;

