/**
 * 헤더의 [개선 요청] 버튼과 작성 창. 로그인한 누구나 Doneline 운영팀에 개선 제안·오류·문의를 보낸다.
 * 서버: POST /api/feedback (backend/src/feedback.ts). 보고 있던 화면 이름을 함께 보내 맥락을 알 수 있게 한다.
 * 창은 브라우저 기본 <dialog>를 써서 열려 있는 동안 뒤 화면 조작을 막고 Esc로 닫을 수 있게 한다.
 */
import { useRef, useState } from 'react';
import { api } from './api';
import { Notify } from './Toasts';
import { Icon } from './Icon';

const empty = { kind: 'IMPROVEMENT', title: '', body: '' };

export function FeedbackButton({ page, notify }: { page?: string; notify: Notify }) {
  const dialog = useRef<HTMLDialogElement>(null),
    [draft, setDraft] = useState(empty),
    [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const r = await api('feedback', {
        method: 'POST',
        body: JSON.stringify({ ...draft, page: page || '' }),
      });
      setDraft(empty);
      dialog.current?.close();
      notify(r.message, 'success');
    } catch (err) {
      // 실패하면 창과 입력을 그대로 두어 다시 보낼 수 있게 한다.
      notify((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button className="header-link" onClick={() => dialog.current?.showModal()}>
        <Icon name="message" size={16} />
        <span>개선 요청</span>
      </button>
      <dialog ref={dialog} className="code-lookup feedback-dialog" aria-label="개선 요청">
        <form onSubmit={submit}>
          <h2>개선 요청</h2>
          <p className="hint">
            불편한 점이나 바라는 기능을 알려주세요. Doneline 운영팀이 확인합니다.
            {page ? ` (현재 화면: ${page})` : ''}
          </p>
          <label>
            구분
            <select
              value={draft.kind}
              onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
            >
              <option value="IMPROVEMENT">개선 제안</option>
              <option value="BUG">오류 신고</option>
              <option value="QUESTION">문의</option>
            </select>
          </label>
          <label>
            제목
            <input
              required
              maxLength={200}
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          <label>
            내용
            <textarea
              required
              rows={6}
              maxLength={5000}
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
          </label>
          <div className="lookup-actions">
            <button type="button" disabled={busy} onClick={() => dialog.current?.close()}>
              닫기
            </button>
            <button className="primary" disabled={busy}>
              {busy ? '보내는 중…' : '보내기'}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
