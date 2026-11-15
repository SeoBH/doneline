-- 감사 기록·알림의 남은 표시 문제 정리(QA 3차 DLV3-001·DL-014·DLV2-010).
-- 1) 법인·부서·사용자 기록의 참조 번호(customer_id=5 등)를 'CODE 이름' 글자로 바꾼다.
--    앞으로는 서버(accounts.ts readableAudit)가 기록할 때 바꿔 넣고, 이미 쌓인 기록은 여기서 고친다.
--    참조 대상이 이미 삭제돼 이름을 찾을 수 없는 번호는 그대로 둔다.
-- 2) 삭제인데 'XXX_SAVE'로 남은 기능 코드를 'XXX_DELETE'로 고친다(감사 로그에서 '저장'으로 보이던 문제).
-- 3) 조사 처리 전에 저장된 알림 문장 "'처리 중'(으)로"를 받침에 맞게 고친다.
BEGIN;

-- format(): %I는 칸 이름, %s는 표 이름을 SQL 글자에 끼워 넣는다. 키 6개 × 변경 전/후를 같은 규칙으로 반복한다.
-- jsonb_set(값, '{키}', 새 값): 그 키만 바꾼 새 JSON을 만든다. ~ '^[0-9]+$': 숫자로만 된 값(아직 번호인 것)만 고친다.
DO $$
DECLARE
  ref record;
  col text;
BEGIN
  FOR ref IN SELECT * FROM (VALUES
    ('customer_id', 'app.customers'), ('customerId', 'app.customers'),
    ('corporation_id', 'app.corporations'), ('department_id', 'app.departments'),
    ('resp_id', 'app.responsibilities'), ('respId', 'app.responsibilities')) AS t(k, tbl)
  LOOP
    FOREACH col IN ARRAY ARRAY['before_values', 'after_values'] LOOP
      EXECUTE format(
        'UPDATE audit.audit_changes a SET %1$I = jsonb_set(a.%1$I, ARRAY[%2$L], to_jsonb(r.code || '' '' || r.name))
         FROM %3$s r
         WHERE a.entity_type IN (''corporations'', ''departments'', ''users'')
           AND a.%1$I ->> %2$L ~ ''^[0-9]+$''
           AND r.id = (a.%1$I ->> %2$L)::bigint',
        col, ref.k, ref.tbl);
    END LOOP;
  END LOOP;
END $$;

-- 삭제 기록(변경 종류가 DELETE뿐인 이벤트)의 기능 코드 끝 '_SAVE' → '_DELETE'.
UPDATE audit.audit_events e
SET action = left(e.action, -5) || '_DELETE'
WHERE e.action IN ('CUSTOMERS_SAVE', 'CORPORATIONS_SAVE', 'DEPARTMENTS_SAVE', 'USERS_SAVE')
  AND EXISTS (SELECT 1 FROM audit.audit_changes c WHERE c.event_id = e.event_id AND c.change_type = 'DELETE')
  AND NOT EXISTS (SELECT 1 FROM audit.audit_changes c WHERE c.event_id = e.event_id AND c.change_type <> 'DELETE');

-- 상태 이름 중 받침이 있는 것은 '처리 중'뿐이라 '으로', 나머지(접수·확인 대기·완료·취소)는 '로'.
UPDATE app.notifications SET message = replace(message, '''처리 중''(으)로', '''처리 중''으로')
WHERE message LIKE '%''처리 중''(으)로%';
UPDATE app.notifications SET message = regexp_replace(message, '''(접수|확인 대기|완료|취소)''\(으\)로', '''\1''로', 'g')
WHERE message ~ '''(접수|확인 대기|완료|취소)''\(으\)로';

COMMENT ON COLUMN audit.audit_changes.before_values IS '변경 전 값(JSON). 비밀값(가입 링크 토큰·비밀번호 등)은 넣지 않는다. 고객사·법인·부서·역할 참조는 번호 대신 기록 시점의 ''CODE 이름'' 글자. INSERT면 NULL.';
COMMENT ON COLUMN audit.audit_changes.after_values IS '변경 후 값(JSON). 비밀값(가입 링크 토큰·비밀번호 등)은 넣지 않는다. 고객사·법인·부서·역할 참조는 번호 대신 기록 시점의 ''CODE 이름'' 글자. DELETE면 NULL.';

INSERT INTO public.schema_migrations (version) VALUES ('023_audit_readable_refs');
COMMIT;
