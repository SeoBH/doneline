-- 최초 업무·감사 스키마. 메뉴는 공유 가능한 비순환 그래프이며 변경 함수의 자문 잠금으로 동시 순환 생성을 막는다. 권한 관련 변경은 전역 버전을 올린다.
BEGIN;
CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE TABLE IF NOT EXISTS app.menus (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS app.responsibilities (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  root_menu_id bigint NOT NULL REFERENCES app.menus,
  is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS app.users (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  login_id text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  resp_id bigint NOT NULL REFERENCES app.responsibilities,
  is_active boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_resp_idx ON app.users(resp_id);
CREATE TABLE IF NOT EXISTS app.menu_edges (
  parent_menu_id bigint NOT NULL REFERENCES app.menus,
  child_menu_id bigint NOT NULL REFERENCES app.menus,
  sort_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY(parent_menu_id,child_menu_id),
  CHECK(parent_menu_id <> child_menu_id)
);
CREATE INDEX IF NOT EXISTS menu_edges_child_idx ON app.menu_edges(child_menu_id);
CREATE TABLE IF NOT EXISTS app.screens (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  purpose text NOT NULL DEFAULT '',
  component_key text,
  is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS app.screen_buttons (
  screen_id bigint NOT NULL REFERENCES app.screens,
  action_code text NOT NULL CHECK(action_code IN ('RESET','QUERY','SAVE','DELETE','ETC1','ETC2','ETC3','ETC4')),
  label text NOT NULL,
  is_used boolean NOT NULL DEFAULT false,
  PRIMARY KEY(screen_id,action_code)
);
CREATE TABLE IF NOT EXISTS app.menu_screens (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  menu_id bigint NOT NULL REFERENCES app.menus,
  screen_id bigint NOT NULL REFERENCES app.screens,
  sort_order integer NOT NULL DEFAULT 0,
  UNIQUE(menu_id,screen_id)
);
CREATE INDEX IF NOT EXISTS menu_screens_screen_idx ON app.menu_screens(screen_id);
CREATE TABLE IF NOT EXISTS app.menu_screen_buttons (
  menu_screen_id bigint NOT NULL REFERENCES app.menu_screens,
  action_code text NOT NULL CHECK(action_code IN ('RESET','QUERY','SAVE','DELETE','ETC1','ETC2','ETC3','ETC4')),
  is_allowed boolean NOT NULL DEFAULT false,
  PRIMARY KEY(menu_screen_id,action_code)
);
CREATE TABLE IF NOT EXISTS app.authorization_state (
  id integer PRIMARY KEY CHECK(id=1),
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app.authorization_state(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS app.auth_sessions (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  user_id bigint NOT NULL REFERENCES app.users,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON app.auth_sessions(user_id);
CREATE TABLE IF NOT EXISTS app.idempotency_records (
  user_id bigint NOT NULL REFERENCES app.users,
  operation_key text NOT NULL,
  payload_hash text NOT NULL,
  status text NOT NULL CHECK(status IN ('PENDING','SUCCESS','FAILURE')),
  result_reference jsonb,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(user_id,operation_key)
);
CREATE TABLE IF NOT EXISTS audit.audit_events (
  event_id uuid PRIMARY KEY,
  operation_id uuid NOT NULL,
  request_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK(source IN ('SERVER','CLIENT')),
  user_id bigint,
  actor_snapshot jsonb,
  resp_id bigint,
  menu_id bigint,
  screen_id bigint,
  action text NOT NULL,
  phase text NOT NULL CHECK(phase IN ('START','END','EVENT')),
  outcome text CHECK(outcome IN ('SUCCESS','FAILURE','ERROR','UNKNOWN','CANCELLED')),
  target_type text,
  target_id text,
  duration_ms bigint CHECK(duration_ms>=0),
  affected_count bigint CHECK(affected_count>=0),
  error_code text,
  safe_message text,
  metadata jsonb
);
CREATE INDEX IF NOT EXISTS audit_events_time_idx ON audit.audit_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_user_time_idx ON audit.audit_events(user_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_screen_time_idx ON audit.audit_events(screen_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_request_idx ON audit.audit_events(request_id);
CREATE INDEX IF NOT EXISTS audit_events_operation_idx ON audit.audit_events(operation_id);
CREATE TABLE IF NOT EXISTS audit.audit_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES audit.audit_events,
  entity_type text NOT NULL,
  entity_key text NOT NULL,
  change_type text NOT NULL CHECK(change_type IN ('INSERT','UPDATE','DELETE')),
  before_values jsonb,
  after_values jsonb
);
CREATE INDEX IF NOT EXISTS audit_changes_event_idx ON audit.audit_changes(event_id);
CREATE TABLE IF NOT EXISTS audit.error_details (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES audit.audit_events,
  exception_type text,
  redacted_stack text,
  service_name text
);
CREATE INDEX IF NOT EXISTS error_details_event_idx ON audit.error_details(event_id);
-- Serialize menu structure mutations BEFORE executing their DML statements.
-- Runtime role cannot mutate menu_edges directly; this function owns the lock protocol.
CREATE OR REPLACE FUNCTION app.set_menu_edge(p_parent bigint,p_child bigint,p_sort integer DEFAULT 0,p_remove boolean DEFAULT false) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(720260910);
 IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'Menu mutations require READ COMMITTED'; END IF;
 IF p_remove THEN
  DELETE FROM app.menu_edges WHERE parent_menu_id=p_parent AND child_menu_id=p_child;
 ELSE
  IF p_parent=p_child OR EXISTS(WITH RECURSIVE descendants(id) AS (SELECT p_child UNION SELECT e.child_menu_id FROM app.menu_edges e JOIN descendants d ON e.parent_menu_id=d.id) SELECT 1 FROM descendants WHERE id=p_parent) THEN RAISE EXCEPTION 'Menu cycle is not allowed' USING ERRCODE='23514'; END IF;
  INSERT INTO app.menu_edges VALUES(p_parent,p_child,p_sort) ON CONFLICT(parent_menu_id,child_menu_id) DO UPDATE SET sort_order=EXCLUDED.sort_order;
 END IF;
END $$;
REVOKE ALL ON FUNCTION app.set_menu_edge(bigint,bigint,integer,boolean) FROM PUBLIC;
CREATE OR REPLACE FUNCTION app.bump_authorization_version() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$
BEGIN UPDATE app.authorization_state SET version=version+1,updated_at=now() WHERE id=1; RETURN NULL; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['menus','menu_edges','responsibilities','screens','screen_buttons','menu_screens','menu_screen_buttons'] LOOP
 EXECUTE format('DROP TRIGGER IF EXISTS authorization_changed ON app.%I',t);
 EXECUTE format('CREATE TRIGGER authorization_changed AFTER INSERT OR UPDATE OR DELETE ON app.%I FOR EACH STATEMENT EXECUTE FUNCTION app.bump_authorization_version()',t);
 END LOOP;
END $$;
INSERT INTO public.schema_migrations(version) VALUES('001_initial') ON CONFLICT DO NOTHING;
COMMIT;
