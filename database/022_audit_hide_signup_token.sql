-- 감사 기록에 남은 고객사 가입 링크 토큰 지우기(QA 2차 DLV2-001).
-- 고객사를 저장할 때 DB 행 전체를 변경 전후 값으로 기록해 signup_token(가입 링크 열쇠)이 감사 로그 화면에 보였다.
-- 앞으로는 서버(accounts.ts auditValues)가 기록 전에 빼고, 이미 쌓인 기록은 여기서 지운다.
-- jsonb의 '-' 연산자: 해당 키만 지운 새 JSON을 만든다. 다른 기록 내용은 그대로 둔다.
BEGIN;

UPDATE audit.audit_changes
SET before_values = before_values - 'signup_token',
    after_values = after_values - 'signup_token'
WHERE entity_type = 'customers'
  AND (before_values ? 'signup_token' OR after_values ? 'signup_token');

COMMENT ON COLUMN audit.audit_changes.before_values IS '변경 전 값(JSON). 비밀값(가입 링크 토큰·비밀번호 등)은 넣지 않는다. INSERT면 NULL.';
COMMENT ON COLUMN audit.audit_changes.after_values IS '변경 후 값(JSON). 비밀값(가입 링크 토큰·비밀번호 등)은 넣지 않는다. DELETE면 NULL.';

INSERT INTO public.schema_migrations (version) VALUES ('022_audit_hide_signup_token');
COMMIT;
