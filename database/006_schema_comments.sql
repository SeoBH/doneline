-- 001~005 이후 DB 소유자 계정으로 적용한다. 업무 데이터·제약·권한은 변경하지 않고 설명과 마이그레이션 이력만 기록한다.
-- 재실행해도 같은 설명으로 갱신된다. DBeaver 등에서 객체를 새로고침하면 설명을 확인할 수 있다.
BEGIN;

-- 메뉴 폴더 원장. 실제 부모·자식 관계는 menu_edges에서 관리한다.
COMMENT ON TABLE app.menus IS '메뉴 폴더 원장. 실제 부모·자식 관계는 menu_edges에서 관리한다.';
COMMENT ON COLUMN app.menus.id IS '행을 식별하는 자동 생성 bigint 키.';
COMMENT ON COLUMN app.menus.code IS '고유 업무 코드. 등록 후 변경은 immutable_code 트리거가 거절함.';
COMMENT ON COLUMN app.menus.name IS '사용자에게 표시하는 명칭.';
COMMENT ON COLUMN app.menus.is_active IS '사용 여부. 기본값 true이며 비활성 계정·RESP·메뉴·화면은 인증 또는 권한 계산에서 제외.';
COMMENT ON COLUMN app.menus.version IS '동시 편집 충돌 검사용 행 버전. 기본값 1, UPDATE 트리거가 1 증가시키며 클라이언트 버전과 비교.';
COMMENT ON COLUMN app.menus.created_by IS '등록 당시 사용자 표시명. 트랜잭션의 app.actor_name에서 기본값을 읽으며 기존 행·직접 SQL 입력은 NULL 가능.';
COMMENT ON COLUMN app.menus.created_at IS '등록 시각. 기본값 now(), 시간대 포함. 컬럼 추가 전 기존 등록 행은 NULL 가능.';

-- 사용자에게 부여하는 RESP 권한 그룹. 시작 메뉴에서 도달 가능한 화면과 버튼을 사용한다.
COMMENT ON TABLE app.responsibilities IS '사용자에게 부여하는 RESP 권한 그룹. 시작 메뉴에서 도달 가능한 화면과 버튼을 사용한다.';
COMMENT ON COLUMN app.responsibilities.id IS '행을 식별하는 자동 생성 bigint 키.';
COMMENT ON COLUMN app.responsibilities.code IS '고유 업무 코드. 등록 후 변경은 immutable_code 트리거가 거절함.';
COMMENT ON COLUMN app.responsibilities.name IS '사용자에게 표시하는 명칭.';
COMMENT ON COLUMN app.responsibilities.root_menu_id IS '시작 메뉴 ID(app.menus.id). NULL은 아직 시작 메뉴를 연결하지 않은 RESP.';
COMMENT ON COLUMN app.responsibilities.is_active IS '사용 여부. 기본값 true이며 비활성 계정·RESP·메뉴·화면은 인증 또는 권한 계산에서 제외.';
COMMENT ON COLUMN app.responsibilities.version IS '동시 편집 충돌 검사용 행 버전. 기본값 1, UPDATE 트리거가 1 증가시키며 클라이언트 버전과 비교.';
COMMENT ON COLUMN app.responsibilities.created_by IS '등록 당시 사용자 표시명. 트랜잭션의 app.actor_name에서 기본값을 읽으며 기존 행·직접 SQL 입력은 NULL 가능.';
COMMENT ON COLUMN app.responsibilities.created_at IS '등록 시각. 기본값 now(), 시간대 포함. 컬럼 추가 전 기존 등록 행은 NULL 가능.';

-- 로그인 계정과 RESP 배정. 비밀번호·RESP·활성 상태 변경 시 기존 세션을 폐기한다.
COMMENT ON TABLE app.users IS '로그인 계정과 RESP 배정. 비밀번호·RESP·활성 상태 변경 시 기존 세션을 폐기한다.';
COMMENT ON COLUMN app.users.id IS '행을 식별하는 자동 생성 bigint 키.';
COMMENT ON COLUMN app.users.login_id IS '로그인에 사용하는 고유 계정명.';
COMMENT ON COLUMN app.users.password_hash IS 'Argon2 비밀번호 해시. 비밀번호 원문을 저장하지 않는다.';
COMMENT ON COLUMN app.users.display_name IS '화면 및 등록자 기록에 사용하는 사용자 표시명.';
COMMENT ON COLUMN app.users.resp_id IS '계정에 부여한 RESP ID(app.responsibilities.id).';
COMMENT ON COLUMN app.users.is_active IS '사용 여부. 기본값 true이며 비활성 계정·RESP·메뉴·화면은 인증 또는 권한 계산에서 제외.';
COMMENT ON COLUMN app.users.must_change_password IS 'true이면 업무 접근 전에 비밀번호 변경이 필요함. 신규 계정 기본값 true.';
COMMENT ON COLUMN app.users.created_at IS '등록 시각. 기본값 now(), 시간대 포함. 컬럼 추가 전 기존 등록 행은 NULL 가능.';
COMMENT ON COLUMN app.users.updated_at IS '계정 갱신 시각. 비밀번호 변경 코드에서 now()로 갱신하며 모든 UPDATE에 자동 갱신되는 컬럼은 아님.';

-- 메뉴 부모·자식 연결. 여러 부모가 같은 자식을 공유할 수 있으며 순환은 전용 변경 함수가 거절한다.
COMMENT ON TABLE app.menu_edges IS '메뉴 부모·자식 연결. 여러 부모가 같은 자식을 공유할 수 있으며 순환은 전용 변경 함수가 거절한다.';
COMMENT ON COLUMN app.menu_edges.parent_menu_id IS '상위 메뉴 ID(app.menus.id). child_menu_id와 함께 기본키.';
COMMENT ON COLUMN app.menu_edges.child_menu_id IS '하위 메뉴 ID(app.menus.id). 자신 또는 조상으로의 연결은 허용하지 않음.';
COMMENT ON COLUMN app.menu_edges.sort_order IS '같은 부모 아래 표시 순서. 작은 값 우선, 기본값 0. 메뉴 구성 적용 시 배열 인덱스를 저장.';
COMMENT ON COLUMN app.menu_edges.id IS '행을 식별하는 자동 생성 bigint 키.';
COMMENT ON COLUMN app.menu_edges.version IS '동시 편집 충돌 검사용 행 버전. 기본값 1, UPDATE 트리거가 1 증가시키며 클라이언트 버전과 비교.';
COMMENT ON COLUMN app.menu_edges.hidden IS '해당 연결을 메뉴 트리에서 숨길지 여부. 기본값 false. 숨김만으로 서버 접근 권한을 취소하지 않음.';
COMMENT ON COLUMN app.menu_edges.created_by IS '등록 당시 사용자 표시명. 트랜잭션의 app.actor_name에서 기본값을 읽으며 기존 행·직접 SQL 입력은 NULL 가능.';
COMMENT ON COLUMN app.menu_edges.created_at IS '등록 시각. 기본값 now(), 시간대 포함. 컬럼 추가 전 기존 등록 행은 NULL 가능.';

-- 화면 정의. 실제 프런트 구현은 component_key 허용 목록과 연결한다.
COMMENT ON TABLE app.screens IS '화면 정의. 실제 프런트 구현은 component_key 허용 목록과 연결한다.';
COMMENT ON COLUMN app.screens.id IS '행을 식별하는 자동 생성 bigint 키.';
COMMENT ON COLUMN app.screens.code IS '고유 업무 코드. 등록 후 변경은 immutable_code 트리거가 거절함.';
COMMENT ON COLUMN app.screens.name IS '사용자에게 표시하는 명칭.';
COMMENT ON COLUMN app.screens.purpose IS '화면 용도 설명. 기본값은 빈 문자열.';
COMMENT ON COLUMN app.screens.component_key IS '프런트 화면 구현 식별자. sourceModules 또는 화면 분기에서 해석하며 NULL/미등록 키는 준비되지 않은 화면으로 표시.';
COMMENT ON COLUMN app.screens.is_active IS '사용 여부. 기본값 true이며 비활성 계정·RESP·메뉴·화면은 인증 또는 권한 계산에서 제외.';
COMMENT ON COLUMN app.screens.version IS '동시 편집 충돌 검사용 행 버전. 기본값 1, UPDATE 트리거가 1 증가시키며 클라이언트 버전과 비교.';
COMMENT ON COLUMN app.screens.created_by IS '등록 당시 사용자 표시명. 트랜잭션의 app.actor_name에서 기본값을 읽으며 기존 행·직접 SQL 입력은 NULL 가능.';
COMMENT ON COLUMN app.screens.created_at IS '등록 시각. 기본값 now(), 시간대 포함. 컬럼 추가 전 기존 등록 행은 NULL 가능.';

-- 화면 자체의 8개 공통 동작 정의. 사용 여부와 메뉴별 허용 여부를 모두 만족해야 실행 가능하다.
COMMENT ON TABLE app.screen_buttons IS '화면 자체의 8개 공통 동작 정의. 사용 여부와 메뉴별 허용 여부를 모두 만족해야 실행 가능하다.';
COMMENT ON COLUMN app.screen_buttons.screen_id IS '버튼이 속한 화면 ID(app.screens.id). action_code와 함께 기본키.';
COMMENT ON COLUMN app.screen_buttons.action_code IS '공통 동작 코드: RESET, QUERY, SAVE, DELETE, ETC1, ETC2, ETC3, ETC4.';
COMMENT ON COLUMN app.screen_buttons.label IS '화면 버튼 정의의 명칭. 현재 공통 툴바 문구는 프런트 소스 정의가 우선함.';
COMMENT ON COLUMN app.screen_buttons.is_used IS '화면에서 이 동작을 사용하는지 여부. 기본값 false이며 true만 메뉴 권한과 결합해 실행 가능.';

-- 메뉴에 배치된 화면. 같은 화면도 메뉴마다 별도 버튼 권한을 가질 수 있다.
COMMENT ON TABLE app.menu_screens IS '메뉴에 배치된 화면. 같은 화면도 메뉴마다 별도 버튼 권한을 가질 수 있다.';
COMMENT ON COLUMN app.menu_screens.id IS '행을 식별하는 자동 생성 bigint 키.';
COMMENT ON COLUMN app.menu_screens.menu_id IS '화면을 배치한 메뉴 ID(app.menus.id).';
COMMENT ON COLUMN app.menu_screens.screen_id IS '배치한 화면 ID(app.screens.id). 같은 메뉴·화면 조합은 중복 불가.';
COMMENT ON COLUMN app.menu_screens.sort_order IS '같은 부모 아래 표시 순서. 작은 값 우선, 기본값 0. 메뉴 구성 적용 시 배열 인덱스를 저장.';
COMMENT ON COLUMN app.menu_screens.version IS '동시 편집 충돌 검사용 행 버전. 기본값 1, UPDATE 트리거가 1 증가시키며 클라이언트 버전과 비교.';
COMMENT ON COLUMN app.menu_screens.hidden IS '해당 연결을 메뉴 트리에서 숨길지 여부. 기본값 false. 숨김만으로 서버 접근 권한을 취소하지 않음.';
COMMENT ON COLUMN app.menu_screens.created_by IS '등록 당시 사용자 표시명. 트랜잭션의 app.actor_name에서 기본값을 읽으며 기존 행·직접 SQL 입력은 NULL 가능.';
COMMENT ON COLUMN app.menu_screens.created_at IS '등록 시각. 기본값 now(), 시간대 포함. 컬럼 추가 전 기존 등록 행은 NULL 가능.';

-- 메뉴·화면 배치별 동작 권한. screen_buttons.is_used와 함께 검사한다.
COMMENT ON TABLE app.menu_screen_buttons IS '메뉴·화면 배치별 동작 권한. screen_buttons.is_used와 함께 검사한다.';
COMMENT ON COLUMN app.menu_screen_buttons.menu_screen_id IS '권한이 적용되는 배치 ID(app.menu_screens.id). action_code와 함께 기본키.';
COMMENT ON COLUMN app.menu_screen_buttons.action_code IS '공통 동작 코드: RESET, QUERY, SAVE, DELETE, ETC1, ETC2, ETC3, ETC4.';
COMMENT ON COLUMN app.menu_screen_buttons.is_allowed IS '해당 배치에서 동작을 허용하는지 여부. 기본값 false. 화면 자체에서 사용 중인 동작에만 효력이 있음.';

-- 프로세스별 권한 캐시 무효화를 위한 단일 행. 권한 관련 테이블 변경 트리거가 version을 증가시킨다.
COMMENT ON TABLE app.authorization_state IS '프로세스별 권한 캐시 무효화를 위한 단일 행. 권한 관련 테이블 변경 트리거가 version을 증가시킨다.';
COMMENT ON COLUMN app.authorization_state.id IS '고정값 1인 단일 행 키.';
COMMENT ON COLUMN app.authorization_state.version IS '전체 권한 구성 버전(bigint). 관련 테이블 변경 시 증가하며 캐시 갱신 여부 판단에 사용.';
COMMENT ON COLUMN app.authorization_state.updated_at IS '전역 권한 버전이 마지막으로 변경된 시각.';

-- 서버 세션 저장소. 비로그인 CSRF 세션도 포함하며 세션은 삭제 대신 폐기 시각으로 무효화한다.
COMMENT ON TABLE app.auth_sessions IS '서버 세션 저장소. 비로그인 CSRF 세션도 포함하며 세션은 삭제 대신 폐기 시각으로 무효화한다.';
COMMENT ON COLUMN app.auth_sessions.id IS '서버에서 생성하는 세션 행 UUID. 브라우저 쿠키의 원문 ID와는 다름.';
COMMENT ON COLUMN app.auth_sessions.token_hash IS '브라우저 세션 ID의 SHA-256 해시. 원문 ID 대신 조회 키로 사용하며 고유함.';
COMMENT ON COLUMN app.auth_sessions.user_id IS '로그인 사용자 ID(app.users.id). NULL이면 로그인 전 CSRF 세션.';
COMMENT ON COLUMN app.auth_sessions.created_at IS '세션 행 생성 시각. 시간대 포함.';
COMMENT ON COLUMN app.auth_sessions.last_activity_at IS '마지막 명시적 사용자 활동 시각. 일반 조회 요청이나 자동 touch는 갱신하지 않음.';
COMMENT ON COLUMN app.auth_sessions.idle_expires_at IS '사용자 활동이 없을 때 만료되는 시각. 활동 시 연장되지만 절대 만료를 넘지 못함.';
COMMENT ON COLUMN app.auth_sessions.absolute_expires_at IS '발급 기준 최대 유효 시각. 기본 앱 설정은 8시간이며 활동으로 연장하지 않음.';
COMMENT ON COLUMN app.auth_sessions.revoked_at IS '세션 폐기 시각. NULL이면 명시적 폐기 전이나 만료·계정 상태 검사도 통과해야 사용 가능.';
COMMENT ON COLUMN app.auth_sessions.session_data IS 'express-session 본문 JSON. 쿠키 설정·사용자 ID·CSRF 토큰·발급 시각 등을 포함하므로 민감정보로 취급.';

-- 로그인 시도 제한 버킷. 계정 및 IP별 카운터를 DB에 저장하여 서버 인스턴스 간 공유한다.
COMMENT ON TABLE app.login_limits IS '로그인 시도 제한 버킷. 계정 및 IP별 카운터를 DB에 저장하여 서버 인스턴스 간 공유한다.';
COMMENT ON COLUMN app.login_limits.bucket IS 'account: 또는 ip: 접두사와 SHA-256 해시를 결합한 제한 대상 식별자.';
COMMENT ON COLUMN app.login_limits.attempts IS '현재 15분 창에서 누적한 시도 횟수. 만료 후 첫 시도에서는 1로 재설정.';
COMMENT ON COLUMN app.login_limits.expires_at IS '현재 제한 창 만료 시각. 다음 시도 시 만료 여부를 확인하여 창을 갱신.';

-- 중복 업무 요청 방지를 위한 예약 테이블. 현재 등록 API에서는 사용하지 않는다.
COMMENT ON TABLE app.idempotency_records IS '중복 업무 요청 방지를 위한 예약 테이블. 현재 등록 API에서는 사용하지 않는다.';
COMMENT ON COLUMN app.idempotency_records.user_id IS '요청 사용자 ID(app.users.id). operation_key와 함께 기본키.';
COMMENT ON COLUMN app.idempotency_records.operation_key IS '사용자 범위에서 중복 요청을 구분할 업무 키.';
COMMENT ON COLUMN app.idempotency_records.payload_hash IS '같은 키로 서로 다른 요청 본문이 들어오는지 비교할 해시.';
COMMENT ON COLUMN app.idempotency_records.status IS '처리 상태: PENDING(진행 중), SUCCESS(성공), FAILURE(실패).';
COMMENT ON COLUMN app.idempotency_records.result_reference IS '재요청에 반환할 결과 참조 JSON. 결과가 없으면 NULL.';
COMMENT ON COLUMN app.idempotency_records.expires_at IS '중복 판정 기록의 유효 기한. 자동 정리 작업은 현재 구현되지 않음.';

-- 인증·API·설정 변경의 감사 이벤트. 앱 역할은 추가만 가능하며 수정·삭제하지 못한다.
COMMENT ON TABLE audit.audit_events IS '인증·API·설정 변경의 감사 이벤트. 앱 역할은 추가만 가능하며 수정·삭제하지 못한다.';
COMMENT ON COLUMN audit.audit_events.event_id IS '감사 이벤트 UUID 기본키.';
COMMENT ON COLUMN audit.audit_events.operation_id IS '관련 이벤트를 묶는 업무 작업 UUID. 현재 단일 서버 이벤트는 event_id와 같은 값을 사용.';
COMMENT ON COLUMN audit.audit_events.request_id IS 'HTTP 요청 추적 UUID. 요청 외 작업은 NULL 가능.';
COMMENT ON COLUMN audit.audit_events.occurred_at IS '이벤트 발생 시각. 기본값 now(), 시간대 포함.';
COMMENT ON COLUMN audit.audit_events.received_at IS 'DB에 이벤트를 수신한 시각. 기본값 now(), 시간대 포함.';
COMMENT ON COLUMN audit.audit_events.source IS '발생 주체: SERVER(서버), CLIENT(클라이언트).';
COMMENT ON COLUMN audit.audit_events.user_id IS '행위 사용자 ID. 비로그인 사건은 NULL 가능하며 사용자 삭제 후 기록 보존을 위해 외래키 없음.';
COMMENT ON COLUMN audit.audit_events.actor_snapshot IS '발생 당시 행위자 정보 JSON. 현재 공통 기록 함수는 미설정(NULL).';
COMMENT ON COLUMN audit.audit_events.resp_id IS '발생 당시 RESP ID. 미수집이면 NULL, 이력 보존을 위해 외래키 없음.';
COMMENT ON COLUMN audit.audit_events.menu_id IS '작업한 메뉴 ID. 메뉴 외 작업 또는 미수집이면 NULL, 외래키 없음.';
COMMENT ON COLUMN audit.audit_events.screen_id IS '작업한 화면 ID. 미수집이면 NULL, 외래키 없음.';
COMMENT ON COLUMN audit.audit_events.action IS '업무 동작 식별자. LOGIN, REGISTER_UPDATE, MENU_APPLY 또는 HTTP 메서드와 경로 등.';
COMMENT ON COLUMN audit.audit_events.phase IS '처리 단계: START(시작), END(종료), EVENT(독립 사건).';
COMMENT ON COLUMN audit.audit_events.outcome IS '결과: SUCCESS, FAILURE, ERROR, UNKNOWN, CANCELLED. 결과 확정 전은 NULL 가능.';
COMMENT ON COLUMN audit.audit_events.target_type IS '대상 종류. 예: screens. 대상 미지정이면 NULL.';
COMMENT ON COLUMN audit.audit_events.target_id IS '대상 식별자를 문자열로 보관. 대상 미지정이면 NULL.';
COMMENT ON COLUMN audit.audit_events.duration_ms IS '처리 소요 시간(밀리초), 0 이상. 미측정이면 NULL.';
COMMENT ON COLUMN audit.audit_events.affected_count IS '영향받은 행 수, 0 이상. 미집계이면 NULL.';
COMMENT ON COLUMN audit.audit_events.error_code IS '분류 가능한 오류 코드 또는 HTTP 상태 코드 문자열. 정상 또는 미지정이면 NULL.';
COMMENT ON COLUMN audit.audit_events.safe_message IS '민감정보를 제거한 사용자용 메시지. 미지정이면 NULL.';
COMMENT ON COLUMN audit.audit_events.metadata IS '추가 감사 정보 JSON. 비밀번호·원문 토큰 등 비밀값을 포함하지 않아야 함.';

-- 감사 이벤트에 연결된 데이터 변경 전후 기록. 업무 변경과 같은 트랜잭션에 저장한다.
COMMENT ON TABLE audit.audit_changes IS '감사 이벤트에 연결된 데이터 변경 전후 기록. 업무 변경과 같은 트랜잭션에 저장한다.';
COMMENT ON COLUMN audit.audit_changes.id IS '행을 식별하는 자동 생성 bigint 키.';
COMMENT ON COLUMN audit.audit_changes.event_id IS '관련 감사 이벤트 ID(audit.audit_events.event_id).';
COMMENT ON COLUMN audit.audit_changes.entity_type IS '변경한 엔터티 또는 테이블명. 예: menus, screens, responsibilities.';
COMMENT ON COLUMN audit.audit_changes.entity_key IS '변경 대상 기본키의 문자열 표현.';
COMMENT ON COLUMN audit.audit_changes.change_type IS '변경 종류: INSERT(생성), UPDATE(수정), DELETE(삭제).';
COMMENT ON COLUMN audit.audit_changes.before_values IS '변경 전 상태 JSON. 신규 생성이면 NULL. 메뉴 구성 변경은 부모와 연결 목록을 포함.';
COMMENT ON COLUMN audit.audit_changes.after_values IS '변경 후 상태 JSON. 삭제이면 NULL.';

-- 기술 오류 상세용 예약 테이블. 앱은 추가 가능하며 일반 감사 조회 뷰에는 노출하지 않는다.
COMMENT ON TABLE audit.error_details IS '기술 오류 상세용 예약 테이블. 앱은 추가 가능하며 일반 감사 조회 뷰에는 노출하지 않는다.';
COMMENT ON COLUMN audit.error_details.id IS '행을 식별하는 자동 생성 bigint 키.';
COMMENT ON COLUMN audit.error_details.event_id IS '관련 감사 이벤트 ID(audit.audit_events.event_id).';
COMMENT ON COLUMN audit.error_details.exception_type IS '예외 클래스 또는 오류 분류명. 미수집이면 NULL.';
COMMENT ON COLUMN audit.error_details.redacted_stack IS '민감정보를 제거한 오류 스택. 원본 비밀번호·토큰을 기록하지 않아야 함.';
COMMENT ON COLUMN audit.error_details.service_name IS '오류가 발생한 서비스 이름. 미수집이면 NULL.';

COMMENT ON VIEW audit.event_summary IS '일반 감사 조회에 허용한 이벤트 요약. 원본 스택과 추가 메타데이터는 제외한다.';
COMMENT ON COLUMN audit.event_summary.event_id IS '감사 이벤트 UUID 기본키.';
COMMENT ON COLUMN audit.event_summary.request_id IS 'HTTP 요청 추적 UUID. 요청 외 작업은 NULL 가능.';
COMMENT ON COLUMN audit.event_summary.occurred_at IS '이벤트 발생 시각. 기본값 now(), 시간대 포함.';
COMMENT ON COLUMN audit.event_summary.user_id IS '행위 사용자 ID. 비로그인 사건은 NULL 가능하며 사용자 삭제 후 기록 보존을 위해 외래키 없음.';
COMMENT ON COLUMN audit.event_summary.resp_id IS '발생 당시 RESP ID. 미수집이면 NULL, 이력 보존을 위해 외래키 없음.';
COMMENT ON COLUMN audit.event_summary.menu_id IS '작업한 메뉴 ID. 메뉴 외 작업 또는 미수집이면 NULL, 외래키 없음.';
COMMENT ON COLUMN audit.event_summary.screen_id IS '작업한 화면 ID. 미수집이면 NULL, 외래키 없음.';
COMMENT ON COLUMN audit.event_summary.action IS '업무 동작 식별자. LOGIN, REGISTER_UPDATE, MENU_APPLY 또는 HTTP 메서드와 경로 등.';
COMMENT ON COLUMN audit.event_summary.phase IS '처리 단계: START(시작), END(종료), EVENT(독립 사건).';
COMMENT ON COLUMN audit.event_summary.outcome IS '결과: SUCCESS, FAILURE, ERROR, UNKNOWN, CANCELLED. 결과 확정 전은 NULL 가능.';
COMMENT ON COLUMN audit.event_summary.error_code IS '분류 가능한 오류 코드 또는 HTTP 상태 코드 문자열. 정상 또는 미지정이면 NULL.';
COMMENT ON COLUMN audit.event_summary.safe_message IS '민감정보를 제거한 사용자용 메시지. 미지정이면 NULL.';
COMMENT ON VIEW audit.config_changes IS '메뉴·화면·RESP 및 연결 엔터티로 제한한 변경 전후 조회 뷰.';
COMMENT ON COLUMN audit.config_changes.id IS '행을 식별하는 자동 생성 bigint 키.';
COMMENT ON COLUMN audit.config_changes.event_id IS '관련 감사 이벤트 ID(audit.audit_events.event_id).';
COMMENT ON COLUMN audit.config_changes.entity_type IS '변경한 엔터티 또는 테이블명. 예: menus, screens, responsibilities.';
COMMENT ON COLUMN audit.config_changes.entity_key IS '변경 대상 기본키의 문자열 표현.';
COMMENT ON COLUMN audit.config_changes.change_type IS '변경 종류: INSERT(생성), UPDATE(수정), DELETE(삭제).';
COMMENT ON COLUMN audit.config_changes.before_values IS '변경 전 상태 JSON. 신규 생성이면 NULL. 메뉴 구성 변경은 부모와 연결 목록을 포함.';
COMMENT ON COLUMN audit.config_changes.after_values IS '변경 후 상태 JSON. 삭제이면 NULL.';

INSERT INTO public.schema_migrations(version) VALUES ('006_schema_comments') ON CONFLICT DO NOTHING;
COMMIT;
