/**
 * 개선 요청 수신함(FEEDBACK_INBOX, 운영 워크스페이스 전용). 모든 업체에서 들어온 개선 요청을 보고 처리 상태를 바꾼다.
 * 서버: GET /api/feedback, POST /api/feedback/:id/status (backend/src/feedback.ts).
 * 상태를 바꾼 행만 저장하며 성공하면 다시 조회한다. 실패하면 선택한 상태를 유지한다.
 */
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { api } from './api';
import { Screen, ScreenHandle, ViewState } from './types';
import { Notify } from './Toasts';
import { dateTime } from './srLabels';

const KIND: Record<string, string> = {
  IMPROVEMENT: '개선 제안',
  BUG: '오류 신고',
  QUESTION: '문의',
};
const STATUS: Record<string, string> = {
  NEW: '접수',
  REVIEWED: '검토함',
  PLANNED: '반영 예정',
  DONE: '반영 완료',
  DECLINED: '반영 안 함',
};

export const FeedbackInboxScreen = forwardRef<
  ScreenHandle,
  { screen: Screen; notify: Notify; onState: (s: ViewState) => void }
>(function FeedbackInboxScreen({ screen, notify, onState }, ref) {
  const [items, setItems] = useState<any[]>([]),
    // 행 ID → 바꾼 상태. 저장 전까지 화면에서만 보관한다.
    [edits, setEdits] = useState<Record<string, string>>({}),
    [open, setOpen] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const changed = items.filter((r) => edits[r.id] && edits[r.id] !== r.status);
  useEffect(() => onState({ busy, dirty: changed.length > 0 }), [busy, changed.length, onState]);
  const headers = { 'X-Menu-ID': screen.menu_id };
  async function load() {
    setItems((await api('feedback', { headers })).items);
    setEdits({});
  }
  async function query() {
    setBusy(true);
    try {
      await load();
      notify('조회했습니다.', 'success');
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!changed.length) {
      notify('변경된 내용이 없습니다.');
      return false;
    }
    if (!window.confirm(changed.length + '건의 상태를 저장할까요?')) return false;
    for (const r of changed)
      await api('feedback/' + r.id + '/status', {
        method: 'POST',
        headers,
        body: JSON.stringify({ status: edits[r.id], version: r.version }),
      });
    await load();
    notify('상태를 저장했습니다.', 'success');
    return true;
  }
  useImperativeHandle(ref, () => ({ query, reset: () => setEdits({}), save }));
  useEffect(() => {
    void load().catch((e) => notify((e as Error).message, 'error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <p className="hint">제목을 누르면 내용을 펼칩니다. 상태를 바꾼 뒤 상단 [저장]을 누르세요.</p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>접수</th>
              <th>업체</th>
              <th>작성자</th>
              <th>구분</th>
              <th>제목</th>
              <th>화면</th>
              <th>상태</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id}>
                <td>{dateTime(r.created_at)}</td>
                <td>{r.workspace_name}</td>
                <td>{r.user_name}</td>
                <td>{KIND[r.kind]}</td>
                <td className="feedback-title">
                  <button
                    className="link-button"
                    onClick={() => setOpen(open === String(r.id) ? null : String(r.id))}
                  >
                    {r.title}
                  </button>
                  {open === String(r.id) && <div className="sr-body">{r.body}</div>}
                </td>
                <td>{r.page || '—'}</td>
                <td>
                  <select
                    aria-label={r.title + ' 상태'}
                    value={edits[r.id] || r.status}
                    disabled={busy || !screen.buttons.SAVE?.allowed}
                    onChange={(e) => setEdits({ ...edits, [r.id]: e.target.value })}
                  >
                    {Object.entries(STATUS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
});
