/**
 * Cloudflare Pages Function: doneline.pages.dev/api/* 요청을 PC에서 실행 중인 백엔드(Cloudflare 터널 주소)로 전달한다.
 * 화면 파일은 Pages가 직접 제공하고, API만 이 함수가 대신 보낸다. 브라우저 입장에서는 화면과 API가 같은
 * pages.dev 주소라서 로그인 쿠키와 서버의 Origin 검사가 그대로 동작한다.
 * 환경변수 BACKEND_ORIGIN: 터널 주소(예: https://xxxx.trycloudflare.com). Pages 프로젝트 설정에서 지정한다.
 * 파일명 [[path]]는 /api 아래의 모든 하위 경로를 이 함수 하나로 받는다는 Pages 규칙이다.
 */
export async function onRequest({ request, env }) {
  if (!env.BACKEND_ORIGIN)
    return Response.json({ message: '데모 서버가 연결되지 않았습니다.' }, { status: 503 });
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  // 실제 접속자 IP를 백엔드의 로그인 시도 제한에 쓰도록 전달한다(백엔드는 TRUST_PROXY=1일 때만 신뢰).
  headers.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP') || '');
  headers.set('X-Forwarded-Proto', 'https');
  headers.delete('Host');
  try {
    // redirect: 'manual' — 백엔드 응답(쿠키 포함)을 바꾸지 않고 그대로 브라우저에 돌려준다.
    return await fetch(env.BACKEND_ORIGIN + url.pathname + url.search, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
    });
  } catch {
    // PC가 꺼져 있거나 터널이 끊긴 경우.
    return Response.json(
      { message: '데모 서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.' },
      { status: 502 },
    );
  }
}
