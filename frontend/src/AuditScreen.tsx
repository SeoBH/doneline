/**
 * 감사 로그 화면. 누가 언제 무엇을 했는지 최신순으로 보여 주고, 권한·메뉴 설정 변경은 변경 전후를 펼쳐 본다.
 * QA DL-014 반영: 기능·결과를 한국어로, 사용자는 이름(아이디)로, 기간·기능·사용자·결과로 거르고 50건씩 넘겨 본다.
 * 화면을 열면 바로 조회한다. 서버: navigation.ts의 admin/audit-events(업체별 RLS 적용).
 */
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { api } from './api';
import { Screen, ScreenHandle, ViewState } from './types';
import { Notify } from './Toasts';
import { dateTime } from './srLabels';

// 서버가 기록하는 기능 코드 → 화면 이름. 목록에 없는 코드는 원래 코드를 그대로 보여 준다.
const ACTION: Record<string, string> = {
  LOGIN: '로그인',
  LOGOUT: '로그아웃',
  PASSWORD_CHANGE: '비밀번호 변경',
  PASSWORD_RESET: '비밀번호 재설정',
  EMAIL_VERIFY: '이메일 인증',
  SESSION_EXPIRED: '로그인 만료',
  NAVIGATION: '메뉴 불러오기',
  WORKSPACE_SIGNUP: '업체 가입',
  SIGNUP_REQUEST: '고객 회원가입 신청',
  USER_CREATE: '사용자 등록',
  USER_UPDATE: '사용자 정보 변경',
  USER_APPROVE: '가입 승인',
  USER_REJECT: '가입 반려',
  USER_SUSPEND: '사용자 정지',
  USER_MAPPING: '법인·부서 지정',
  USER_PASSWORD_LINK: '비밀번호 설정 링크 발급',
  USERS_SAVE: '사용자 기본정보 저장',
  USERS_DELETE: '사용자 삭제',
  USER_SCOPES_SAVE: '법인·부서 지정 저장',
  USER_QUERY: '사용자 조회',
  SIGNUP_LINK_ROTATE: '가입 링크 교체',
  SESSION_LOAD: '로그인 정보 확인',
  CUSTOMERS_SAVE: '고객사 저장',
  CUSTOMERS_DELETE: '고객사 삭제',
  CORPORATIONS_SAVE: '법인 저장',
  CORPORATIONS_DELETE: '법인 삭제',
  DEPARTMENTS_SAVE: '부서 저장',
  DEPARTMENTS_DELETE: '부서 삭제',
  SR_CREATE: '요청 등록',
  SR_UPDATE: '요청 처리',
  SR_COMMENT: '요청 댓글',
  SR_ATTACH: '파일 첨부',
  SR_CONFIRM: '고객 완료 확인',
  SR_REOPEN: '고객 재처리 요청',
  SR_AUTO_CLOSE: '확인 기간 경과 자동 완료',
  SR_AUTO_CLOSE_FAILED: '자동 완료 실패',
  SLA_SAVE: 'SLA 설정 저장',
  REPORT_EXPORT: '월간 리포트 엑셀 내려받기',
  FEEDBACK_SUBMIT: '개선 요청 보내기',
  FEEDBACK_STATUS: '개선 요청 상태 변경',
  AUDIT_QUERY: '감사 로그 조회',
  AUDIT_DETAIL: '감사 상세 조회',
  MENU_LAYOUT_QUERY: '화면 구성 조회',
  REGISTER_QUERY: '등록 목록 조회',
  RESP_LINK_QUERY: '역할 연결 조회',
  SCREEN_REGISTER: '화면 등록',
  MENU_REGISTER: '메뉴 등록',
  MENU_APPLY: '메뉴 구성 적용',
  RESP_REGISTER: '역할 등록',
  RESP_APPLY: '역할 시작 메뉴 적용',
};
// 업체가 처음 한 번 맞춰 두는 화면·메뉴·역할 구성 기능. 평소에는 쓰지 않아 기능 목록 아래 '시스템 구성'으로 묶는다(QA DLV3-006).
const SYSTEM_ACTIONS = new Set([
  'MENU_LAYOUT_QUERY',
  'REGISTER_QUERY',
  'RESP_LINK_QUERY',
  'SCREEN_REGISTER',
  'MENU_REGISTER',
  'MENU_APPLY',
  'RESP_REGISTER',
  'RESP_APPLY',
]);
const OUTCOME: Record<string, string> = {
  SUCCESS: '성공',
  FAILURE: '실패',
  ERROR: '오류',
  CANCELLED: '취소',
};
// 실패한 요청은 서버가 'GET /api/requests/desk'처럼 요청 주소로 기록한다. 주소를 그대로 보여 주지 않고
// 앞부분으로 어느 화면의 일인지 찾아 '업체 작업함 조회 거절'처럼 바꾼다(QA DL-014·DLV2-008).
const AREA: [string, string][] = [
  ['/api/requests/desk', '업체 작업함'],
  ['/api/requests/portal', '고객 요청'],
  ['/api/catalogs/customers', '고객사등록'],
  ['/api/catalogs/corporations', '법인등록'],
  ['/api/catalogs/departments', '부서등록'],
  ['/api/catalogs', '코드 등록'],
  ['/api/accounts', '사용자등록'],
  ['/api/users', '사용자등록'],
  ['/api/admin/audit', '감사 로그'],
  ['/api/reports', '월간 리포트'],
  ['/api/sla', 'SLA 설정'],
  ['/api/feedback', '개선 요청'],
  ['/api/notifications', '알림'],
  ['/api/signup', '고객 회원가입'],
  ['/api/workspaces', '업체 가입'],
  ['/api/auth', '로그인'],
  ['/api/recovery', '계정 찾기'],
  ['/api/register', '등록 화면'],
  ['/api/menus', '메뉴'],
  ['/api/navigation', '메뉴'],
];
function actionLabel(a: string) {
  if (ACTION[a]) return ACTION[a];
  const m = /^(GET|POST|PUT|DELETE) (\S+)/.exec(a);
  if (!m) return a === 'HTTP_REQUEST' ? '요청 처리' : a;
  const area = AREA.find(([prefix]) => m[2].startsWith(prefix))?.[1] || '기타 기능';
  return `${area} ${m[1] === 'GET' ? '조회' : '처리'}`;
}
// 실패 기록의 HTTP 상태 번호 → 사용자에게 보여 줄 이유.
const REASON: Record<string, string> = {
  '400': '입력값 오류',
  '401': '로그인 필요',
  '403': '권한 없음',
  '404': '대상 없음',
  // 409는 같은 코드·아이디가 이미 있을 때와, 다른 사람이 먼저 고쳐 버전이 맞지 않을 때 모두 쓴다(QA 4차 DV4-004).
  '409': '중복 또는 다른 작업과 충돌',
  '413': '파일 크기 초과',
  '429': '시도 횟수 초과',
  '503': '일시적 연결 문제',
};
function outcomeLabel(row: { outcome: string; error_code?: string | null }) {
  const base = OUTCOME[row.outcome] || row.outcome;
  if (row.outcome === 'SUCCESS' || !row.error_code) return base;
  const reason = REASON[row.error_code] || (row.error_code.startsWith('5') ? '서버 오류' : '');
  return reason ? `${base} · ${reason}` : base;
}
// '변경 내용 보기'의 대상·필드 이름. 표·칸 이름(영문)을 그대로 보이지 않게 한국어로 바꾼다(QA DLV2-001).
const ENTITY: Record<string, string> = {
  customers: '고객사',
  corporations: '법인',
  departments: '부서',
  users: '사용자',
  user_scopes: '법인·부서 지정',
  menus: '메뉴',
  screens: '화면',
  responsibilities: '역할',
  menu_edges: '메뉴 연결',
  menu_screens: '메뉴 화면 연결',
};
const CHANGE: Record<string, string> = { INSERT: '등록', UPDATE: '수정', DELETE: '삭제' };
const FIELD: Record<string, string> = {
  code: '코드',
  name: '이름',
  is_active: '사용 여부',
  customerId: '고객사',
  customer_id: '고객사',
  corporation_id: '법인',
  respId: '역할',
  resp_id: '역할',
  department_id: '부서',
  email: '이메일',
  status: '상태',
  note: '사유',
  loginId: '아이디',
  corporations: '지정 법인',
  departments: '지정 부서',
  signupLink: '가입 링크',
  action: '작업',
  hidden: '메뉴 숨김',
  sort_order: '순서',
  authority_type: '접근 구분',
  level: '레벨',
  title: '제목',
  route: '화면 경로',
};
// 사람이 볼 필요가 없는 내부 번호·버전·시각 칸은 변경 내용 표에서 뺀다.
const HIDDEN_FIELDS = new Set(['id', 'workspace_id', 'version', 'created_at', 'updated_at']);
// 칸 값으로 저장된 영문 코드 → 한국어(QA DL-014). 상태·접근 구분·작업 종류처럼 정해진 값만 바꾼다.
const VALUE: Record<string, Record<string, string>> = {
  status: { PENDING: '승인 대기', ACTIVE: '사용 중', REJECTED: '반려', SUSPENDED: '정지' },
  account_status: { PENDING: '승인 대기', ACTIVE: '사용 중', REJECTED: '반려', SUSPENDED: '정지' },
  authority_type: { SYSTEM: '우리 업체', CUSTOMER: '고객사' },
  action: { PASSWORD_LINK_PREPARED: '비밀번호 설정 링크 준비' },
};
function show(v: unknown, key = ''): string {
  if (v === undefined || v === null || v === '') return '—';
  if (typeof v === 'boolean') return v ? '예' : '아니요';
  if (Array.isArray(v)) return v.length ? v.map((x) => show(x)).join(', ') : '없음';
  // 예전 법인·부서 지정 기록은 [{corporation_id: 3}]처럼 객체 묶음이라 안의 값만 꺼내 보인다.
  if (typeof v === 'object')
    return Object.values(v as object)
      .map((x) => show(x))
      .join(' ');
  return VALUE[key]?.[String(v)] || String(v);
}
/** 변경 전·후 값을 '항목 | 변경 전 | 변경 후' 줄로 펼친다. 바뀐 줄을 위로, 같은 값은 아래로 보낸다. */
function changeRows(before: any, after: any) {
  const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])].filter(
    (k) => !HIDDEN_FIELDS.has(k),
  );
  return keys
    .map((k) => ({
      label: FIELD[k] || k,
      before: show(before?.[k], k),
      after: show(after?.[k], k),
    }))
    .map((r) => ({ ...r, changed: r.before !== r.after }))
    .sort((a, b) => Number(b.changed) - Number(a.changed));
}
const emptyFilter = { from: '', to: '', action: '', user: '', outcome: '', reads: '' };

export const AuditScreen = forwardRef<
  ScreenHandle,
  { screen: Screen; notify: Notify; onState: (s: ViewState) => void }
>(function AuditScreen({ screen, notify, onState }, ref) {
  // 창틀에 '준비됨'을 알린다. 이 알림으로 툴바 버튼이 풀린다(감사 로그는 편집 내용이 없어 dirty는 항상 false).
  useEffect(() => onState({ busy: false, dirty: false }), [onState]);
  const [items, setItems] = useState<any[]>([]);
  const [detail, setDetail] = useState<any[]>([]);
  const [opened, setOpened] = useState('');
  const [filter, setFilter] = useState(emptyFilter);
  const [page, setPage] = useState(1);
  const [hasNext, setHasNext] = useState(false);
  const [loaded, setLoaded] = useState(false);
  async function query(p = 1, f = filter, quiet = false) {
    try {
      // URLSearchParams: 거르기 조건을 주소 뒤 ?from=...&to=... 형식으로 안전하게 붙인다(한글·공백 인코딩).
      const q = new URLSearchParams({ page: String(p), ...f });
      const r = await api('admin/audit-events?' + q, {
        headers: { 'X-Menu-ID': screen.menu_id },
      });
      setItems(r.items);
      setHasNext(Boolean(r.hasNext));
      setPage(r.page || p);
      setDetail([]);
      setOpened('');
      setLoaded(true);
      if (!quiet) notify('조회했습니다.', 'success');
    } catch (e) {
      notify((e as Error).message, 'error');
    }
  }
  // 화면을 열면 바로 최근 기록을 보여 준다(다른 화면과 같은 동작).
  useEffect(() => {
    void query(1, emptyFilter, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function changes(eventId: string) {
    try {
      const r = await api('admin/audit-events/' + eventId + '/changes', {
        headers: { 'X-Menu-ID': screen.menu_id },
      });
      setDetail(r.items);
      setOpened(eventId);
    } catch (e) {
      notify((e as Error).message, 'error');
    }
  }
  useImperativeHandle(ref, () => ({
    query: () => query(1),
    reset: () => {
      setFilter(emptyFilter);
      void query(1, emptyFilter, true);
    },
  }));
  const set = (k: keyof typeof emptyFilter, v: string) => setFilter({ ...filter, [k]: v });
  return (
    <>
      <div className="query-bar" aria-label="조회 조건">
        <label>
          시작일
          <input type="date" value={filter.from} onChange={(e) => set('from', e.target.value)} />
        </label>
        <label>
          종료일
          <input type="date" value={filter.to} onChange={(e) => set('to', e.target.value)} />
        </label>
        <label>
          사용자
          <input
            value={filter.user}
            placeholder="이름 또는 아이디"
            onChange={(e) => set('user', e.target.value)}
          />
        </label>
        <label>
          기능
          <select value={filter.action} onChange={(e) => set('action', e.target.value)}>
            <option value="">전체</option>
            {/* optgroup: 선택 목록 안의 묶음 제목. 자주 쓰는 기능을 위에, 시스템 구성 기능을 아래 묶음에 둔다. */}
            {Object.entries(ACTION)
              .filter(([k]) => !SYSTEM_ACTIONS.has(k))
              .map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            <optgroup label="시스템 구성(화면·메뉴·역할)">
              {Object.entries(ACTION)
                .filter(([k]) => SYSTEM_ACTIONS.has(k))
                .map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
            </optgroup>
          </select>
        </label>
        <label>
          결과
          <select value={filter.outcome} onChange={(e) => set('outcome', e.target.value)}>
            <option value="">전체</option>
            {Object.entries(OUTCOME).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        {/* 메뉴 불러오기·감사 로그 조회처럼 보기만 한 기록은 수가 많아 기본으로 숨긴다(QA DL-014). */}
        <label className="sr-check audit-reads">
          <input
            type="checkbox"
            checked={filter.reads === '1'}
            onChange={(e) => set('reads', e.target.checked ? '1' : '')}
          />
          조회 기록도 보기
        </label>
      </div>
      <p className="hint">
        조건을 고른 뒤 [조회]를 누르세요. 저장·삭제·승인처럼 데이터를 바꾼 기록은 [변경 내용 보기]로
        바뀐 항목을 확인할 수 있습니다. 문의할 때는 해당 줄의 '문의용 번호'를 알려 주세요.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>시각</th>
              <th>기능</th>
              <th>결과</th>
              <th>사용자</th>
              <th>변경 내용</th>
              <th>문의용 번호</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <tr key={row.event_id} className={opened === row.event_id ? 'selected' : ''}>
                <td>{dateTime(row.occurred_at)}</td>
                <td>{actionLabel(row.action)}</td>
                <td>{outcomeLabel(row)}</td>
                <td>
                  {row.user_name
                    ? `${row.user_name} (${row.user_login})`
                    : row.user_id
                      ? '삭제된 사용자'
                      : '—'}
                </td>
                <td>
                  {row.has_changes ? (
                    <button className="link-button" onClick={() => changes(row.event_id)}>
                      변경 내용 보기
                    </button>
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  <small>{String(row.request_id || '').slice(0, 8)}</small>
                </td>
              </tr>
            ))}
            {loaded && !items.length && (
              <tr>
                <td colSpan={6}>조건에 맞는 기록이 없습니다.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="pager">
        <button disabled={page <= 1} onClick={() => void query(page - 1, filter, true)}>
          이전 50건
        </button>
        <span>{page}쪽</span>
        <button disabled={!hasNext} onClick={() => void query(page + 1, filter, true)}>
          다음 50건
        </button>
      </div>
      {detail.map((d) => (
        <section className="change-detail" key={d.id}>
          <h3>
            {ENTITY[d.entity_type] || d.entity_type} {CHANGE[d.change_type] || d.change_type}
          </h3>
          <table>
            <thead>
              <tr>
                <th>항목</th>
                <th>변경 전</th>
                <th>변경 후</th>
              </tr>
            </thead>
            <tbody>
              {changeRows(d.before_values, d.after_values).map((r) => (
                <tr key={r.label} className={r.changed ? 'changed' : undefined}>
                  <td>{r.label}</td>
                  <td>{r.before}</td>
                  <td>{r.after}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </>
  );
});
