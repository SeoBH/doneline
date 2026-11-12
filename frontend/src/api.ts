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
export async function api(path: string, options: RequestInit = {}) {
  // async 함수는 Promise(나중에 완료될 결과)를 반환하고 await는 응답을 기다린다.
  // ...는 객체 속성을 펼친다. 뒤에 쓴 값이 우선하므로 화면별 헤더로 기본 헤더를 덮어쓸 수 있다.
  const res = await fetch('/api/' + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...options.headers },
  });
  const data = await res.json();
  // fetch는 HTTP 400/500 응답만으로 예외를 던지지 않아 상태를 직접 검사한다.
  if (!res.ok)
    throw new ApiError(
      data.message + (data.requestId ? ' · ' + data.requestId : ''),
      res.status,
      data.rowErrors || [],
    );
  if (data.csrfToken) csrf = data.csrfToken;
  return data;
}
