/** 고객사별 링크에서만 해당 고객사 코드 목록을 받아 가입 신청한다. RESP는 관리자가 배정하며 가입자는 기본정보만 입력한다. */
import { useEffect, useState } from 'react';
import { api } from './api';
import { AccountForm, emptyAccount } from './AccountForm';
import { Notify } from './Toasts';
import { checkForm, clearInvalid } from './formCheck';
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
    [done, setDone] = useState(false),
    // 비밀번호 오타로 가입 후 로그인하지 못하는 일을 막기 위한 확인 입력.
    [confirm, setConfirm] = useState('');
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
  // 입력 검사 결과 문장(브라우저 말풍선 대신 폼 안에 보여 준다, formCheck.ts).
  const [formError, setFormError] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const bad = checkForm(e.currentTarget as HTMLFormElement);
    setFormError(bad);
    if (bad) return;
    if (busy || !customer) return;
    if (draft.password !== confirm) {
      setFormError('비밀번호와 비밀번호 확인이 다릅니다.');
      return;
    }
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
      <form className="account-card" onSubmit={submit} noValidate onInput={clearInvalid}>
        <h1>회원가입</h1>
        {customer?.customerName && (
          <p className="signup-banner">
            <strong>{customer.customerName}</strong> 고객 요청 포털
            <span>{customer.workspaceName}에서 운영합니다.</span>
          </p>
        )}
        {done ? (
          <p role="status">
            가입 신청이 완료되었습니다. {customer?.workspaceName || '업체'} 관리자가 승인하고 소속
            부서를 지정하면 로그인할 수 있습니다. 급하면 담당 업체에 승인을 요청해 주세요.
          </p>
        ) : customer ? (
          <>
            <AccountForm
              value={draft}
              onChange={setDraft}
              customer={customer}
              signup
              disabled={busy}
              confirm={confirm}
              onConfirm={setConfirm}
            />
            <button className="primary" disabled={busy}>
              가입 신청
            </button>
          </>
        ) : (
          <p>{busy ? '불러오는 중…' : '가입 링크를 확인해 주세요.'}</p>
        )}
        <button type="button" disabled={busy} onClick={onBack}>
          로그인으로 돌아가기
        </button>
        {formError && (
          <p className="form-error" role="alert">
            {formError}
          </p>
        )}
      </form>
    </main>
  );
}
