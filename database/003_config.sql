-- 동시 편집 충돌 검사용 행 버전과 과거 CONFIG 등록을 추가한다. 메뉴 변경 함수는 컬럼을 명시해 후속 컬럼 추가에도 동작하도록 한다.
BEGIN;
ALTER TABLE app.menu_edges ADD COLUMN IF NOT EXISTS id bigint GENERATED ALWAYS AS IDENTITY;
CREATE UNIQUE INDEX IF NOT EXISTS menu_edges_id_idx ON app.menu_edges(id);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['menus','responsibilities','screens','menu_edges','menu_screens'] LOOP
 EXECUTE format('ALTER TABLE app.%I ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1',t);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION app.increment_row_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.version=OLD.version+1; RETURN NEW; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['menus','responsibilities','screens','menu_edges','menu_screens'] LOOP
 EXECUTE format('DROP TRIGGER IF EXISTS row_version ON app.%I',t);
 EXECUTE format('CREATE TRIGGER row_version BEFORE UPDATE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.increment_row_version()',t);
 END LOOP;
END $$;
-- Explicit columns keep edge writes independent of schema additions.
CREATE OR REPLACE FUNCTION app.set_menu_edge(p_parent bigint,p_child bigint,p_sort integer DEFAULT 0,p_remove boolean DEFAULT false) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(720260910);
 IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'Menu mutations require READ COMMITTED'; END IF;
 IF p_remove THEN
 DELETE FROM app.menu_edges WHERE parent_menu_id=p_parent AND child_menu_id=p_child;
 ELSE
 IF p_parent=p_child OR EXISTS(WITH RECURSIVE descendants(id) AS (SELECT p_child UNION SELECT e.child_menu_id FROM app.menu_edges e JOIN descendants d ON e.parent_menu_id=d.id) SELECT 1 FROM descendants WHERE id=p_parent) THEN RAISE EXCEPTION 'Menu cycle is not allowed' USING ERRCODE='23514'; END IF;
 INSERT INTO app.menu_edges(parent_menu_id,child_menu_id,sort_order) VALUES(p_parent,p_child,p_sort) ON CONFLICT(parent_menu_id,child_menu_id) DO UPDATE SET sort_order=EXCLUDED.sort_order;
 END IF;
END $$;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA app TO cpjt_app;
CREATE OR REPLACE VIEW audit.config_changes AS SELECT id,event_id,entity_type,entity_key,change_type,before_values,after_values FROM audit.audit_changes WHERE entity_type IN ('menus','responsibilities','screens','menu_edges','menu_screens');
GRANT SELECT ON audit.config_changes TO cpjt_app;
INSERT INTO app.screens(code,name,purpose,component_key) VALUES('CONFIG','권한·메뉴 설정','RESP, 메뉴, 화면과 버튼 권한 관리','config') ON CONFLICT(code) DO NOTHING;
INSERT INTO app.screen_buttons(screen_id,action_code,label,is_used)
 SELECT s.id,a.code,a.label,true FROM app.screens s CROSS JOIN (VALUES('RESET','초기화'),('QUERY','조회'),('SAVE','저장'),('DELETE','삭제')) a(code,label)
 WHERE s.code='CONFIG' ON CONFLICT DO NOTHING;
INSERT INTO app.menu_screens(menu_id,screen_id,sort_order)
 SELECT r.root_menu_id,s.id,10 FROM app.responsibilities r CROSS JOIN app.screens s WHERE r.code='ADMIN' AND s.code='CONFIG' ON CONFLICT DO NOTHING;
INSERT INTO app.menu_screen_buttons(menu_screen_id,action_code,is_allowed)
 SELECT ms.id,b.action_code,true FROM app.menu_screens ms JOIN app.screens s ON s.id=ms.screen_id JOIN app.screen_buttons b ON b.screen_id=s.id
 JOIN app.responsibilities r ON r.root_menu_id=ms.menu_id AND r.code='ADMIN' WHERE s.code='CONFIG' ON CONFLICT DO NOTHING;
INSERT INTO public.schema_migrations(version) VALUES('003_config') ON CONFLICT DO NOTHING;
COMMIT;

