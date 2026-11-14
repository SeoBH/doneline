/**
 * 공통 JSON API 호출. 응답의 CSRF 토큰을 메모리에 보관해 다음 요청에 사용한다.
 * ApiError는 HTTP 상태·행별 오류·요청 ID를 전달하며 메뉴 권한 헤더는 호출 화면에서 지정한다.
 */
let csrf = '';
export class ApiError extends Error {
  // 생성자 인수 앞의 public은 받은 값을 같은 이름의 속성으로 보관한다.
  // 호출 화면에서 error.status와 error.rowErrors로 실패 종류와 행별 사유를 읽는다.
  constructor(
    message: string,
    public status: number,
    public rowErrors: any[] = [],
  ) {
    super(message);
  }
}
/** 서버에서 새 CSRF 토큰을 받아 메모리에 넣는다. 실패해도 원래 오류를 보여 주도록 조용히 넘긴다. */
async function refreshCsrf() {
  const res = await fetch('/api/auth/csrf').catch(() => null);
  const data = res?.ok ? await res.json().catch(() => null) : null;
  if (data?.csrfToken) csrf = data.csrfToken;
}
export async function api(path: string, options: RequestInit = {}, retried = false): Promise<any> {
  // async 함수는 Promise(나중에 완료될 결과)를 반환하고 await는 응답을 기다린다.
  // ...는 객체 속성을 펼친다. 뒤에 쓴 값이 우선하므로 화면별 헤더로 기본 헤더를 덮어쓸 수 있다.
  const res = await fetch('/api/' + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...options.headers },
  });
  const data = await res.json();
  // CSRF 토큰이 낡은 경우(다른 탭에서 로그인·로그아웃 등): 서버는 이 검사를 업무 처리 전에 하므로
  // 아무것도 바뀌지 않았다. 새 토큰을 받아 딱 한 번만 다시 보낸다(QA DLV2-018).
  if (res.status === 403 && data.code === 'CSRF' && !retried) {
    await refreshCsrf();
    return api(path, options, true);
  }
  // fetch는 HTTP 400/500 응답만으로 예외를 던지지 않아 상태를 직접 검사한다.
  if (!res.ok) {
    // 요청 번호는 화면에 보이지 않게 하고(사용자에게 의미 없는 긴 문자열), 문의 대응을 위해 콘솔에만 남긴다.
    if (data.requestId) console.warn('Doneline 요청 번호', data.requestId);
    throw new ApiError(data.message, res.status, data.rowErrors || []);
  }
  if (data.csrfToken) csrf = data.csrfToken;
  return data;
}
/**
 * 파일 업로드(multipart/form-data). Content-Type은 브라우저가 경계값(boundary)을 넣어 직접 정하므로 지정하지 않는다.
 * 응답은 api()와 같은 JSON이며 실패 시 ApiError를 던진다.
 */
export async function upload(
  path: string,
  form: FormData,
  headers: Record<string, string> = {},
  retried = false,
): Promise<any> {
  const res = await fetch('/api/' + path, {
    method: 'POST',
    body: form,
    headers: { 'X-CSRF-Token': csrf, ...headers },
  });
  const data = await res.json().catch(() => ({ message: '파일을 올리지 못했습니다.' }));
  if (res.status === 403 && data.code === 'CSRF' && !retried) {
    await refreshCsrf();
    return upload(path, form, headers, true);
  }
  if (!res.ok) {
    if (data.requestId) console.warn('Doneline 요청 번호', data.requestId);
    throw new ApiError(data.message, res.status);
  }
  return data;
}
/**
 * 파일 내려받기. 화면 권한 확인용 X-Menu-ID 머리글을 붙여야 해서 링크 대신 fetch로 받은 뒤,
 * 임시 주소(blob URL)를 만들어 브라우저의 '다운로드'로 저장한다.
 */
export async function download(
  path: string,
  fileName: string,
  headers: Record<string, string> = {},
) {
  const res = await fetch('/api/' + path, { headers });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ message: '파일을 받지 못했습니다.' }));
    throw new ApiError(data.message, res.status);
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  // 브라우저가 저장을 시작할 시간을 준 뒤 임시 주소를 해제해 메모리를 돌려준다.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
