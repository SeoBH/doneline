-- 폐기된 CONFIG가 이전 구현인지 확인하고 삭제 전 상태를 감사 로그에 보존한다. 참조 버튼·배치부터 제거하며 현재 독립 등록 화면은 유지한다.
-- Remove only the retired combined configuration screen; retain its audit history.
BEGIN;
SELECT pg_advisory_xact_lock(720260910);
DO $$
DECLARE old_screen app.screens%ROWTYPE; event_id uuid; snapshot jsonb;
BEGIN
 SELECT * INTO old_screen FROM app.screens WHERE code='CONFIG' FOR UPDATE;
 IF FOUND THEN
  IF old_screen.is_active OR old_screen.component_key IS DISTINCT FROM 'config' THEN
   RAISE EXCEPTION 'CONFIG is no longer the retired screen; inspect before removing it';
  END IF;
  SELECT jsonb_build_object(
   'screen',to_jsonb(old_screen),
   'buttons',COALESCE((SELECT jsonb_agg(to_jsonb(b)) FROM app.screen_buttons b WHERE b.screen_id=old_screen.id),'[]'::jsonb),
   'placements',COALESCE((SELECT jsonb_agg(to_jsonb(m)) FROM app.menu_screens m WHERE m.screen_id=old_screen.id),'[]'::jsonb),
   'grants',COALESCE((SELECT jsonb_agg(to_jsonb(b)) FROM app.menu_screen_buttons b JOIN app.menu_screens m ON m.id=b.menu_screen_id WHERE m.screen_id=old_screen.id),'[]'::jsonb)
  ) INTO snapshot;
  event_id:=gen_random_uuid();
  INSERT INTO audit.audit_events(event_id,operation_id,source,action,phase,outcome,target_type,target_id)
   VALUES(event_id,event_id,'SERVER','REMOVE_LEGACY_CONFIG','END','SUCCESS','screens',old_screen.id::text);
  INSERT INTO audit.audit_changes(event_id,entity_type,entity_key,change_type,before_values)
   VALUES(event_id,'screens',old_screen.id::text,'DELETE',snapshot);
  DELETE FROM app.menu_screen_buttons WHERE menu_screen_id IN (SELECT id FROM app.menu_screens WHERE screen_id=old_screen.id);
  DELETE FROM app.menu_screens WHERE screen_id=old_screen.id;
  DELETE FROM app.screen_buttons WHERE screen_id=old_screen.id;
  DELETE FROM app.screens WHERE id=old_screen.id;
 END IF;
END $$;
INSERT INTO public.schema_migrations(version) VALUES('005_remove_legacy_config') ON CONFLICT DO NOTHING;
COMMIT;
