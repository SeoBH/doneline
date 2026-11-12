-- 앱 역할로 연결해 메뉴 순환 거절과 제한된 권한을 검증한다. 검사 중 만든 행은 마지막 ROLLBACK으로 취소한다.
BEGIN;
-- DO $$ ... $$는 이름 없는 PL/pgSQL 블록이다. DECLARE에서 검사에 사용할 메뉴 ID 변수를 선언한다.
DO $$ DECLARE a bigint; b bigint; BEGIN
 INSERT INTO app.menus(code,name) VALUES('__verify_a','test') RETURNING id INTO a;
 INSERT INTO app.menus(code,name) VALUES('__verify_b','test') RETURNING id INTO b;
 PERFORM app.set_menu_edge(a,b);
 -- PERFORM은 함수 결과를 받지 않고 실행만 한다. a→b가 있는 상태에서 b→a를 시도해 순환을 검사한다.
 BEGIN
  PERFORM app.set_menu_edge(b,a);
  RAISE EXCEPTION 'Cycle was accepted';
 EXCEPTION WHEN check_violation THEN NULL;
 -- 예상한 제약 위반만 잡아서 검사를 계속한다. 순환이 허용되면 위 RAISE EXCEPTION으로 실패한다.
 END;
 IF has_table_privilege(current_user,'audit.audit_events','UPDATE') OR has_table_privilege(current_user,'audit.audit_events','DELETE') THEN RAISE EXCEPTION 'Audit mutation unexpectedly permitted'; END IF;
 IF has_table_privilege(current_user,'app.menu_edges','INSERT') THEN RAISE EXCEPTION 'Direct edge mutation unexpectedly permitted'; END IF;
 INSERT INTO audit.audit_events(event_id,operation_id,source,action,phase,outcome) VALUES(gen_random_uuid(),gen_random_uuid(),'SERVER','VERIFY','EVENT','SUCCESS');
 RAISE NOTICE 'PASS: app connection, cycle rejection, restricted grants, audit insertion';
END $$;
ROLLBACK;
-- 검사 데이터를 확정하지 않는다. 단, 자동 생성 ID의 시퀀스 증가분은 롤백되지 않을 수 있다.
SELECT current_user,current_database();
