-- 독립 등록 화면 도입. 숨김 및 등록자·등록일시를 추가하고 저장된 코드 변경을 트리거로 막는다. 기존 CONFIG 배치와 버튼 권한을 독립 화면으로 이관한다.
BEGIN;
ALTER TABLE app.responsibilities ALTER COLUMN root_menu_id DROP NOT NULL;
ALTER TABLE app.menu_edges ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;
ALTER TABLE app.menu_screens ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['menus','screens','responsibilities','menu_edges','menu_screens'] LOOP
  EXECUTE format('ALTER TABLE app.%I ADD COLUMN IF NOT EXISTS created_by text',t);
  EXECUTE format('ALTER TABLE app.%I ADD COLUMN IF NOT EXISTS created_at timestamptz',t);
  EXECUTE format('ALTER TABLE app.%I ALTER COLUMN created_at SET DEFAULT now()',t);
  EXECUTE format('ALTER TABLE app.%I ALTER COLUMN created_by SET DEFAULT NULLIF(current_setting(''app.actor_name'',true),'''')',t);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION app.immutable_code() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.code IS DISTINCT FROM OLD.code THEN RAISE EXCEPTION 'Saved code is immutable' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['menus','screens','responsibilities'] LOOP
 EXECUTE format('DROP TRIGGER IF EXISTS immutable_code ON app.%I',t);
 EXECUTE format('CREATE TRIGGER immutable_code BEFORE UPDATE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.immutable_code()',t);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION app.set_menu_edge(p_parent bigint,p_child bigint,p_sort integer,p_remove boolean,p_hidden boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 PERFORM app.set_menu_edge(p_parent,p_child,p_sort,p_remove);
 IF NOT p_remove THEN UPDATE app.menu_edges SET hidden=p_hidden WHERE parent_menu_id=p_parent AND child_menu_id=p_child; END IF;
END $$;
REVOKE ALL ON FUNCTION app.set_menu_edge(bigint,bigint,integer,boolean,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.set_menu_edge(bigint,bigint,integer,boolean,boolean) TO doneline_app;
-- Preserve existing definitions and connections; retire only the combined configuration screen.
INSERT INTO app.screens(code,name,component_key) VALUES
 ('SCREEN_REGISTER','화면등록','screen-register'),('MENU_REGISTER','메뉴등록','menu-register'),('RESP_REGISTER','RESP등록','resp-register')
 ON CONFLICT(code) DO NOTHING;
INSERT INTO app.screen_buttons(screen_id,action_code,label,is_used)
 SELECT s.id,b.code,b.label,b.used FROM app.screens s CROSS JOIN
 (VALUES ('RESET','초기화',true),('QUERY','조회',true),('SAVE','저장',true),('DELETE','삭제',true),('ETC1','기타1',false),('ETC2','기타2',false),('ETC3','기타3',false),('ETC4','기타4',false)) b(code,label,used)
 WHERE s.code IN ('SCREEN_REGISTER','MENU_REGISTER','RESP_REGISTER') ON CONFLICT DO NOTHING;
-- Migrate every existing CONFIG placement with the same per-action grants.
INSERT INTO app.menu_screens(menu_id,screen_id,sort_order,hidden)
 SELECT old.menu_id,s.id,old.sort_order+CASE s.code WHEN 'SCREEN_REGISTER' THEN 0 WHEN 'MENU_REGISTER' THEN 1 ELSE 2 END,old.hidden
 FROM app.menu_screens old JOIN app.screens prior ON prior.id=old.screen_id AND prior.code='CONFIG'
 CROSS JOIN app.screens s WHERE s.code IN ('SCREEN_REGISTER','MENU_REGISTER','RESP_REGISTER')
 ON CONFLICT(menu_id,screen_id) DO NOTHING;
INSERT INTO app.menu_screen_buttons(menu_screen_id,action_code,is_allowed)
 SELECT new.id,b.action_code,b.is_allowed FROM app.menu_screens old
 JOIN app.screens prior ON prior.id=old.screen_id AND prior.code='CONFIG'
 JOIN app.menu_screen_buttons b ON b.menu_screen_id=old.id
 JOIN app.menu_screens new ON new.menu_id=old.menu_id JOIN app.screens s ON s.id=new.screen_id
 WHERE s.code IN ('SCREEN_REGISTER','MENU_REGISTER','RESP_REGISTER') ON CONFLICT DO NOTHING;
UPDATE app.screens SET is_active=false WHERE code='CONFIG';
INSERT INTO public.schema_migrations(version) VALUES('004_registration') ON CONFLICT DO NOTHING;
COMMIT;

