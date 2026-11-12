/** 로그인 전 아이디 찾기·인증 재요청·비밀번호 설정 화면. 메일 링크는 GET으로 소비하지 않고 명시적 제출로만 사용한다. */
import { useState } from 'react';
import { api } from './api';
import { Notify } from './Toasts';
export type RecoveryLink = { purpose: 'VERIFY' | 'PASSWORD'; token: string };
export function RecoveryScreen({
  code,
  link,
  onBack,
  notify,
}: {
  code: string;
  link: RecoveryLink | null;
  onBack: () => void;
  notify: Notify;
}) {
  const [kind, setKind] = useState('PASSWORD'),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget),
      password = String(data.get('password') || '');
    if (link?.purpose === 'PASSWORD' && password !== data.get('confirm')) {
      notify('비밀번호 확인이 일치하지 않습니다.');
      return;
    }
    setBusy(true);
    try {
      await api('auth/csrf');
      const body = link
        ? { ...link, password }
        : {
            kind,
            customerCode: code,
            loginId: String(data.get('loginId') || ''),
            email: String(data.get('email') || ''),
          };
      const r = await api('recovery/' + (link ? 'redeem' : 'request'), {
        method: 'POST',
        body: JSON.stringify(body),
      });
      notify(r.message, 'success');
      setDone(true);
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="signup-page">
      <form className="account-card" onSubmit={submit}>
        <h1>
          {link
            ? link.purpose === 'VERIFY'
              ? '이메일 인증'
              : '비밀번호 설정'
            : '계정 찾기·비밀번호 재설정'}
        </h1>
        {done ? (
          <p role="status">
            {link
              ? '처리를 완료했습니다. 로그인 화면으로 돌아가주세요.'
              : '요청을 처리했습니다. 현재 이메일 실제 발송은 보류되어 있으므로 관리자에게 문의해주세요.'}
          </p>
        ) : (
          <>
            {!link && (
              <>
                <p>
                  현재 이메일 실제 발송은 연결되지 않았습니다. 인증된 이메일로 계정을 찾으며,
                  연락처를 사용할 수 없으면 관리자에게 문의해주세요.
                </p>
                <label>
                  요청 종류
                  <select value={kind} onChange={(e) => setKind(e.target.value)} disabled={busy}>
                    <option value="PASSWORD">비밀번호 재설정</option>
                    <option value="ID">아이디 찾기</option>
                    <option value="VERIFY">이메일 인증 재요청</option>
                  </select>
                </label>
                {kind !== 'ID' && (
                  <label>
                    아이디
                    <input
                      name="loginId"
                      required
                      maxLength={80}
                      disabled={busy}
                      autoComplete="username"
                    />
                  </label>
                )}
                <label>
                  이메일
                  <input
                    name="email"
                    type="email"
                    required
                    maxLength={254}
                    disabled={busy}
                    autoComplete="email"
                  />
                </label>
              </>
            )}
            {link?.purpose === 'PASSWORD' && (
              <>
                <label>
                  새 비밀번호
                  <input
                    name="password"
                    type="password"
                    required
                    minLength={15}
                    maxLength={128}
                    disabled={busy}
                    autoComplete="new-password"
                  />
                </label>
                <label>
                  새 비밀번호 확인
                  <input
                    name="confirm"
                    type="password"
                    required
                    minLength={15}
                    maxLength={128}
                    disabled={busy}
                    autoComplete="new-password"
                  />
                </label>
                <small>15~128자. 설정을 완료하면 기존 로그인 세션이 종료됩니다.</small>
              </>
            )}
            {link?.purpose === 'VERIFY' && <p>아래 버튼을 눌러 이메일 소유 확인을 완료해주세요.</p>}
            <button disabled={busy}>{busy ? '처리 중…' : link ? '완료' : '안내 메일 요청'}</button>
          </>
        )}
        <button type="button" disabled={busy} onClick={onBack}>
          로그인으로 돌아가기
        </button>
      </form>
    </main>
  );
}
