/**
 * 이용약관·개인정보처리방침으로 가는 링크 모음(QA DL-005, 2026-11-27 공개).
 * - PolicyConsent: 업체 가입·고객사 회원가입 폼의 필수 동의 체크. 체크하지 않으면 formCheck가 제출을 막는다.
 * - PolicyFooter: 로그인 화면 아래의 작은 줄(서비스 이름 · 약관 · 개인정보처리방침 · 문의 메일).
 * 본문은 PolicyScreen.tsx(/terms, /privacy).
 * 링크는 새 탭으로 연다: 가입 중에 열어도 입력한 내용이 사라지지 않게 하려는 것.
 */

/**
 * 문의 메일 = 앱이 보내는 메일의 보내는 주소(2026-11-27 CEO 결정).
 * import.meta.env.VITE_*: Vite가 빌드할 때 환경변수 값을 화면 파일에 글자로 박아 넣는다.
 * scripts/deploy-pages.ps1이 .env의 MAIL_FROM(없으면 SMTP_USER)에서 주소만 꺼내 넘긴다.
 * 서버에 묻지 않는 이유: 약관·방침은 서버(대표님 PC)가 꺼져 있어도 열려야 한다. 값이 없으면(개발 빌드) 문의 줄을 숨긴다.
 */
export const CONTACT_EMAIL: string = import.meta.env.VITE_CONTACT_EMAIL || '';

export function PolicyConsent({ disabled }: { disabled?: boolean }) {
  return (
    <label className="policy-consent account-wide">
      {/* required: formCheck.ts가 체크 여부를 검사해 "동의가 필요합니다" 문장을 보여 준다. */}
      <input type="checkbox" name="agree" required disabled={disabled} />
      <span>
        [필수]{' '}
        <a href="/terms" target="_blank" rel="noopener">
          이용약관
        </a>
        과{' '}
        <a href="/privacy" target="_blank" rel="noopener">
          개인정보처리방침
        </a>
        을 읽고 동의합니다.
      </span>
    </label>
  );
}

export function PolicyFooter() {
  const email = CONTACT_EMAIL;
  return (
    <nav className="policy-footer" aria-label="서비스 정보">
      <span>Doneline</span>
      <a href="/terms" target="_blank" rel="noopener">
        이용약관
      </a>
      <a href="/privacy" target="_blank" rel="noopener">
        <strong>개인정보처리방침</strong>
      </a>
      {email && <a href={'mailto:' + email}>문의 {email}</a>}
    </nav>
  );
}
