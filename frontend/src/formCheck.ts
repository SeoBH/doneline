/**
 * 입력 폼 검사(브라우저 기본 말풍선 대신). QA DL-009: 기본 말풍선이 라벨을 가리고 영문식 문구가 뜬다.
 * 폼에 noValidate를 두고, 제출할 때 checkForm(form)을 부른다. 잘못된 칸에는 aria-invalid(빨간 테두리)를 붙이고
 * 첫 칸에 초점을 옮긴 뒤 "칸 이름: 이유" 한 문장을 돌려준다. 문제가 없으면 빈 문자열.
 * 검사 기준은 각 입력칸의 required·minLength·maxLength·type·pattern 속성을 그대로 쓴다(서버도 같은 기준으로 다시 검사).
 */
type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

// 라벨 글자만 뽑는다(라벨 안에 들어 있는 입력칸·안내 글자는 빼고 첫 글자 덩어리).
function labelOf(el: Field) {
  const label = el.closest('label');
  const first = label
    ? Array.from(label.childNodes).find((n) => n.nodeType === 3 && n.textContent?.trim())
    : null;
  return (first?.textContent || el.getAttribute('aria-label') || el.name || '입력').trim();
}
function reasonOf(el: Field) {
  const v = el.validity;
  if (v.valueMissing)
    return el instanceof HTMLSelectElement ? '선택해 주세요.' : '필수 입력입니다.';
  if (v.tooShort) return `${(el as HTMLInputElement).minLength}자 이상 입력해 주세요.`;
  if (v.tooLong) return `${(el as HTMLInputElement).maxLength}자 이하로 입력해 주세요.`;
  if (v.typeMismatch && el.type === 'email')
    return '이메일 형식을 확인해 주세요. (예: name@company.com)';
  if (v.patternMismatch) return el.title || '입력 형식을 확인해 주세요.';
  if (v.rangeUnderflow || v.rangeOverflow) return '허용 범위를 확인해 주세요.';
  return '입력값을 확인해 주세요.';
}
export function checkForm(form: HTMLFormElement | null): string {
  if (!form) return '';
  const fields = Array.from(form.elements).filter(
    (e): e is Field => 'checkValidity' in e && !(e as Field).disabled,
  );
  fields.forEach((f) => f.removeAttribute('aria-invalid'));
  const bad = fields.filter((f) => !f.checkValidity());
  if (!bad.length) return '';
  bad.forEach((f) => f.setAttribute('aria-invalid', 'true'));
  bad[0].focus();
  return `${labelOf(bad[0])}: ${reasonOf(bad[0])}`;
}
/** 폼의 onInput에 연결한다. 고치기 시작한 칸의 빨간 표시를 바로 지운다. */
export function clearInvalid(e: { target: EventTarget }) {
  (e.target as HTMLElement).removeAttribute?.('aria-invalid');
}
