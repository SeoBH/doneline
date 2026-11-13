/**
 * 관리자 등록과 고객사 가입에서 재사용하는 기본 정보·RESP 선택 폼이다.
 * 고객사는 가입 링크에서 서버가 결정하고 법인·부서는 승인 후 별도 매핑한다.
 */
export type AccountDraft = {
  loginId: string;
  name: string;
  address: string;
  mobile: string;
  email: string;
  password: string;
  respId: string;
};
export const emptyAccount = (): AccountDraft => ({
  loginId: '',
  name: '',
  address: '',
  mobile: '',
  email: '',
  password: '',
  respId: '',
});
export function AccountForm({
  value,
  onChange,
  customer,
  signup = false,
  disabled = false,
  editing = false,
}: {
  value: AccountDraft;
  onChange: (v: AccountDraft) => void;
  customer: any;
  signup?: boolean;
  disabled?: boolean;
  editing?: boolean;
}) {
  const set = (key: keyof AccountDraft, v: any) => onChange({ ...value, [key]: v });
  return (
    <fieldset disabled={disabled} className="account-fields">
      <div className="field-grid">
        <label>
          아이디
          <input
            disabled={editing}
            value={value.loginId}
            onChange={(e) => set('loginId', e.target.value)}
            required
            maxLength={80}
            pattern="[A-Za-z0-9_.\-]+"
            autoComplete="username"
          />
        </label>
        <label>
          이름
          <input
            value={value.name}
            onChange={(e) => set('name', e.target.value)}
            required
            maxLength={120}
          />
        </label>
        {signup && (
          <label>
            비밀번호
            <input
              type="password"
              aria-label="비밀번호"
              value={value.password}
              onChange={(e) => set('password', e.target.value)}
              required
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
            />
            <small>8~128자</small>
          </label>
        )}
        <label>
          휴대전화번호
          <input
            type="tel"
            value={value.mobile}
            onChange={(e) => set('mobile', e.target.value)}
            required
            maxLength={30}
          />
        </label>
        <label>
          이메일
          <input
            type="email"
            value={value.email}
            onChange={(e) => set('email', e.target.value)}
            required
            maxLength={254}
            autoComplete="email"
          />
        </label>
        <label className="account-wide">
          주소
          <input
            value={value.address}
            onChange={(e) => set('address', e.target.value)}
            maxLength={500}
          />
        </label>
        {!signup && (
          <label>
            역할
            <select
              aria-label="역할"
              required
              value={value.respId}
              onChange={(e) => set('respId', e.target.value)}
            >
              <option value="">선택</option>
              {customer?.responsibilities?.map((r: any) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </fieldset>
  );
}
