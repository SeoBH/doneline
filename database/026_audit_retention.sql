-- 서비스 이용 기록(감사 로그) 1년 보관 후 자동 파기(2026-11-27, 개인정보처리방침 '보유 기간'과 같은 값).
-- 앱 계정(doneline_app)은 감사 기록을 지우거나 고칠 수 없다(grant-app.sql REVOKE). 그 원칙은 그대로 두고,
-- '1년이 지난 기록만, 정해진 양만큼' 지우는 함수 하나만 관리 계정 권한(SECURITY DEFINER)으로 열어 준다.
-- 보관 기간을 인자로 받지 않는 이유: 앱이 실수나 공격으로 최근 기록을 지우게 만들 수 없도록 기간을 함수 안에 고정한다.
-- 업체(워크스페이스) 구분 없이 같은 기준을 적용한다. 함수 주인은 표 주인이라 행 수준 보안(RLS)에 막히지 않는다.
BEGIN;

CREATE FUNCTION audit.purge_expired() RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, audit AS $$
DECLARE
  ids uuid[];
BEGIN
  -- 한 번에 5,000건까지만 지운다(오래 잠그지 않게). 남은 것은 다음 실행(하루 뒤)에 이어서 지운다.
  SELECT array_agg(event_id) INTO ids FROM (
    SELECT event_id FROM audit.audit_events
    WHERE occurred_at < now() - interval '1 year'
    ORDER BY occurred_at LIMIT 5000
  ) t;
  IF ids IS NULL THEN RETURN 0; END IF;
  -- 변경 내용·오류 상세가 이벤트를 참조하므로(외래 키) 먼저 지운다.
  DELETE FROM audit.audit_changes WHERE event_id = ANY(ids);
  DELETE FROM audit.error_details WHERE event_id = ANY(ids);
  DELETE FROM audit.audit_events WHERE event_id = ANY(ids);
  RETURN cardinality(ids);
END $$;
REVOKE ALL ON FUNCTION audit.purge_expired() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.purge_expired() TO doneline_app;
COMMENT ON FUNCTION audit.purge_expired() IS
  '발생 1년이 지난 감사 이벤트(와 딸린 변경 내용·오류 상세)를 오래된 순으로 최대 5,000건 삭제하고 지운 이벤트 수를 돌려준다. 앱 서버가 하루 한 번 호출(backend/src/audit.ts). 보관 기간은 개인정보처리방침과 같게 함수 안에 고정.';
COMMENT ON TABLE audit.audit_events IS
  '인증·API·설정 변경의 감사 이벤트. 앱 역할은 추가만 가능하며 수정·삭제하지 못한다. 예외로 발생 1년이 지난 행은 audit.purge_expired()가 자동 파기한다(2026-11-27 보관 기간).';

INSERT INTO public.schema_migrations (version) VALUES ('026_audit_retention');
COMMIT;
