/** 고객사별 링크에서만 해당 고객사 코드 목록을 받아 가입 신청한다. RESP는 관리자가 배정하며 가입자는 기본정보만 입력한다. */
import { useEffect, useState } from 'react';
import { api } from './api';
import { AccountForm, emptyAccount } from './AccountForm';
import { Notify } from './Toasts';
export function SignupScreen({
  code,
  onBack,
  notify,
}: {
  code: string;
  onBack: () => void;
  notify: Notify;
}) {
  const [customer, setCustomer] = useState<any>(null),
    [draft, setDraft] = useState(emptyAccount),
    [busy, setBusy] = useState(true),
    [done, setDone] = useState(false);
  useEffect(() => {
    let active = true;
    setBusy(true);
    api('signup/' + encodeURIComponent(code))
      .then((r) => {
        if (active) setCustomer(r);
      })
      .catch((e) => {
        if (active) notify(e.message, 'error');
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [code]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !customer) return;
    setBusy(true);
    try {
      await api('auth/csrf');
      const { respId, ...body } = draft;
      const r = await api('signup/' + encodeURIComponent(code), {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setDraft(emptyAccount());
      setDone(true);
      notify(r.message, 'success');
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="signup-page">
      <form className="account-card" onSubmit={submit}>
        <h1>회원가입</h1>
        {done ? (
          <p role="status">
            가입 신청이 완료되었습니다. 관리자 승인과 법인·부서 매핑이 완료되면 로그인할 수
            있습니다.
          </p>
        ) : customer ? (
          <>
            <AccountForm
              value={draft}
              onChange={setDraft}
              customer={customer}
              signup
              disabled={busy}
            />
            <button disabled={busy}>가입 신청</button>
          </>
        ) : (
          <p>{busy ? '불러오는 중…' : '가입 링크를 확인해주세요.'}</p>
        )}
        <button type="button" disabled={busy} onClick={onBack}>
          로그인으로 돌아가기
        </button>
      </form>
    </main>
  );
}
