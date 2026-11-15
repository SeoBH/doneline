-- 승인·반려·정지 감사 기록의 역할 번호를 'CODE 이름' 글자로 바꾸기(QA 4차 DV4-001).
-- 023 이후에도 승인·반려·정지(accounts.ts review)만 readableAudit를 거치지 않아 respId가 번호(예: 2)로 남았다.
-- 서버는 이제 이름으로 기록하고, 이미 쌓인 기록은 여기서 고친다. 역할이 삭제돼 이름을 찾지 못하면 번호를 그대로 둔다.
BEGIN;

-- jsonb_set(값, '{respId}', 새 값): respId 키만 바꾼 새 JSON. ~ '^[0-9]+$': 아직 번호인 값만 고친다.
UPDATE audit.audit_changes a
SET before_values = jsonb_set(a.before_values, '{respId}', to_jsonb(r.code || ' ' || r.name))
FROM app.responsibilities r
WHERE a.entity_type = 'users'
  AND a.before_values ->> 'respId' ~ '^[0-9]+$'
  AND r.id = (a.before_values ->> 'respId')::bigint;

UPDATE audit.audit_changes a
SET after_values = jsonb_set(a.after_values, '{respId}', to_jsonb(r.code || ' ' || r.name))
FROM app.responsibilities r
WHERE a.entity_type = 'users'
  AND a.after_values ->> 'respId' ~ '^[0-9]+$'
  AND r.id = (a.after_values ->> 'respId')::bigint;

INSERT INTO public.schema_migrations (version) VALUES ('024_audit_review_role_names');
COMMIT;
