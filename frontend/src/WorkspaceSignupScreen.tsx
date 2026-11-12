/**
 * 업체(워크스페이스) 무료 가입 화면. 업체 정보와 첫 관리자 계정을 한 번에 입력한다.
 * 서버(backend/src/workspaces.ts)가 업체와 관리자를 함께 만들고, 성공하면 바로 로그인할 수 있다.
 * 고객사 직원 가입(SignupScreen)과 달리 링크가 필요 없고 관리자 승인 단계도 없다.
 */
import { useState } from 'react';
import { api } from './api';
import { Notify } from './Toasts';

const empty = {
  workspaceName: '',
  workspaceCode: '',
  name: '',
  loginId: '',
  email: '',
  mobile: '',
  password: '',
};
// 화면 항목 정의: [필드, 표시 이름, input type, 안내문]. 같은 모양의 입력칸을 반복해서 그린다.
const fields: [keyof typeof empty, string, string, string?][] = [
  ['workspaceName', '업체명', 'text'],
  ['workspaceCode', '업체 코드', 'text', '영문 소문자·숫자·하이픈 2~40자. 예: acme-it'],
  ['name', '관리자 이름', 'text'],
  ['loginId', '아이디', 'text'],
  ['email', '이메일', 'email'],
  ['mobile', '휴대전화', 'tel'],
  ['password', '비밀번호', 'password', '15~128자'],
];

export function WorkspaceSignupScreen({
  onBack,
  notify,
}: {
  onBack: () => void;
  notify: Notify;
}) {
  const [draft, setDraft] = useState(empty),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      // 변경 요청에는 CSRF 토큰이 필요하므로 먼저 받아 둔다(api.ts가 헤더에 붙인다).
      await api('auth/csrf');
      const r = await api('workspaces/signup', { method: 'POST', body: JSON.stringify(draft) });
      setDraft(empty);
      setDone(true);
      notify(r.message, 'success');
    } catch (e) {
      // 실패하면 입력값을 그대로 두어 사용자가 고쳐서 다시 보낼 수 있게 한다.
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="signup-page">
      <form className="account-card" onSubmit={submit}>
        <h1>업체 무료 가입</h1>
        {done ? (
          <p role="status">가입이 완료되었습니다. 로그인 화면에서 바로 시작하세요.</p>
        ) : (
          <fieldset className="account-fields field-grid" disabled={busy}>
            {fields.map(([key, label, type, hint]) => (
              <label key={key}>
                {label}
                <input
                  type={type}
                  value={draft[key]}
                  required
                  autoComplete={key === 'password' ? 'new-password' : undefined}
                  minLength={key === 'password' ? 15 : undefined}
                  maxLength={key === 'password' ? 128 : 254}
                  onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                />
                {hint && <small>{hint}</small>}
              </label>
            ))}
            <button className="account-wide">{busy ? '처리 중…' : '가입하기'}</button>
          </fieldset>
        )}
        <button type="button" disabled={busy} onClick={onBack}>
          로그인으로 돌아가기
        </button>
      </form>
    </main>
  );
}
