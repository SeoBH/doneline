/**
 * 감사 로그 화면. 누가 언제 무엇을 했는지 최신순으로 보여 주고, 권한·메뉴 설정 변경은 변경 전후를 펼쳐 본다.
 * QA DL-014 반영: 기능·결과를 한국어로, 사용자는 이름(아이디)로, 기간·기능·사용자·결과로 거르고 50건씩 넘겨 본다.
 * 화면을 열면 바로 조회한다. 서버: navigation.ts의 admin/audit-events(업체별 RLS 적용).
 */
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { api } from './api';
import { Screen, ScreenHandle } from './types';
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
  USER_DELETE: '사용자 삭제',
  USER_APPROVE: '가입 승인',
  USER_REJECT: '가입 반려',
  USER_SUSPEND: '사용자 정지',
  USER_MAPPING: '법인·부서 지정',
  USER_PASSWORD_LINK: '비밀번호 설정 링크 발급',
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
  SLA_SAVE: 'SLA 설정 저장',
  REPORT_EXPORT: '월간 리포트 엑셀 내려받기',
  FEEDBACK_SUBMIT: '개선 요청 보내기',
  FEEDBACK_STATUS: '개선 요청 상태 변경',
  AUDIT_QUERY: '감사 로그 조회',
  AUDIT_DETAIL: '감사 상세 조회',
  SCREEN_REGISTER: '화면 등록',
  MENU_REGISTER: '메뉴 등록',
  MENU_APPLY: '메뉴 구성 적용',
  RESP_REGISTER: 'RESP 등록',
  RESP_APPLY: 'RESP 시작 메뉴 적용',
};
const OUTCOME: Record<string, string> = {
  SUCCESS: '성공',
  FAILURE: '실패',
  ERROR: '오류',
  CANCELLED: '취소',
};
// 'POST /api/catalogs/:kind/save'처럼 실패한 요청 주소가 기록된 경우는 '요청 실패'로 묶어 보여 준다.
const actionLabel = (a: string) =>
  ACTION[a] || (/^(GET|POST|PUT|DELETE) /.test(a) ? `요청 처리 실패 (${a.split(' ')[1]})` : a);
const emptyFilter = { from: '', to: '', action: '', user: '', outcome: '' };

export const AuditScreen = forwardRef<ScreenHandle, { screen: Screen; notify: Notify }>(
  function AuditScreen({ screen, notify }, ref) {
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
              {Object.entries(ACTION).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
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
        </div>
        <p className="hint">
          조건을 고른 뒤 [조회]를 누르세요. 권한·메뉴 설정을 바꾼 기록은 [변경 내용 보기]로 변경
          전후를 확인할 수 있습니다. 문의할 때는 해당 줄의 '문의용 번호'를 알려 주세요.
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
                  <td>{OUTCOME[row.outcome] || row.outcome}</td>
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
              {d.entity_type} · {d.change_type}
            </h3>
            <div className="field-grid">
              <div>
                <h4>변경 전</h4>
                <pre>{JSON.stringify(d.before_values, null, 2) || '없음'}</pre>
              </div>
              <div>
                <h4>변경 후</h4>
                <pre>{JSON.stringify(d.after_values, null, 2) || '없음'}</pre>
              </div>
            </div>
          </section>
        ))}
      </>
    );
  },
);
