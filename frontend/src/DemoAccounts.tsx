/**
 * 시연 계정 안내 창. 시연 모드 서버(scripts/demo.ps1 -Sample)가 /api/auth/csrf로 계정 목록을 주면
 * 로그인 화면에 처음 한 번 자동으로 띄우고, 닫은 뒤에도 [시연 계정 보기] 버튼으로 다시 열 수 있다.
 * [이 계정으로 입력]을 누르면 로그인 칸에 아이디·비밀번호를 채워 바로 로그인할 수 있게 한다.
 * 관련: backend/demo-seed.cjs(계정 생성), backend/src/config.ts(demoAccounts), main.tsx(로그인 화면).
 */
import { useEffect, useRef, useState } from 'react';

export type DemoAccount = { role: string; loginId: string; password: string; note: string };

/**
 * accounts: 서버가 준 시연 계정(비어 있으면 아무것도 그리지 않는다).
 * onPick: 고른 계정의 아이디·비밀번호를 로그인 칸에 넣는 함수(main.tsx).
 */
export function DemoAccounts({
  accounts,
  onPick,
}: {
  accounts: DemoAccount[];
  onPick: (a: DemoAccount) => void;
}) {
  const [open, setOpen] = useState(true);
  const closeButton = useRef<HTMLButtonElement>(null);
  // 창이 열리면 닫기 버튼에 초점을 둔다(키보드 사용자도 Esc·Enter로 바로 닫을 수 있게).
  useEffect(() => {
    if (open) closeButton.current?.focus();
  }, [open]);
  if (!accounts.length) return null;
  if (!open)
    return (
      <button type="button" className="demo-open" onClick={() => setOpen(true)}>
        시연 계정 보기
      </button>
    );
  return (
    <div className="confirm-backdrop" onMouseDown={() => setOpen(false)}>
      {/* dialog + aria-modal: 뒤 화면을 잠시 쓸 수 없는 안내 창이라는 뜻(화면 낭독기가 창 안만 읽는다). */}
      <div
        className="confirm-dialog demo-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="demo-title"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      >
        <h2 id="demo-title">시연 계정</h2>
        <p>
          가상의 업체 '한빛IT서비스'와 고객사 데이터로 둘러볼 수 있습니다. 역할마다 보이는 화면이
          다릅니다.
        </p>
        <table className="demo-table">
          <thead>
            <tr>
              <th>역할</th>
              <th>아이디</th>
              <th>비밀번호</th>
              <th>바로 입력</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.loginId}>
                <td>
                  <strong>{a.role}</strong>
                  <small>{a.note}</small>
                </td>
                <td>
                  <code>{a.loginId}</code>
                </td>
                <td>
                  <code>{a.password}</code>
                </td>
                <td>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => {
                      onPick(a);
                      setOpen(false);
                    }}
                  >
                    이 계정으로 입력
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="confirm-actions">
          <button type="button" ref={closeButton} onClick={() => setOpen(false)}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
