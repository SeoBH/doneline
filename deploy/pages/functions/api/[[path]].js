/**
 * Cloudflare Pages Function: doneline.pages.dev/api/* 요청을 이 PC에서 실행 중인 백엔드로 전달한다.
 * 화면 파일(frontend/dist)은 Pages가 직접 제공하고, API만 이 함수가 대신 보낸다. 브라우저 입장에서는 화면과 API가
 * 같은 pages.dev 주소라서 로그인 쿠키와 서버의 Origin 검사가 그대로 동작한다.
 * 파일명 [[path]]는 /api 아래의 모든 하위 경로를 이 함수 하나로 받는다는 Pages 규칙이다.
 *
 * Pages 프로젝트 비밀값(wrangler pages secret put, 값은 대화·문서에 남기지 않는다):
 * - BACKEND_ORIGIN: 백엔드 주소. 지금은 Tailscale Funnel 주소(https://<PC이름>.ts.net), 도메인 구매 후 Cloudflare Tunnel 주소.
 * - PROXY_SECRET: 백엔드 .env의 PROXY_SECRET과 같은 값. 백엔드는 이 표식이 붙은 요청만 받는다(app.ts).
 * 관련: scripts/deploy-pages.ps1(배포), backend/test/proxy.test.cjs(동작 검증).
 */
export async function onRequest({ request, env }) {
  // 설정이 빠졌으면 백엔드로 보내지 않는다(표식 없는 요청은 어차피 거절되므로 원인을 바로 알 수 있게 한다).
  if (!env.BACKEND_ORIGIN || !env.PROXY_SECRET)
    return Response.json({ message: '서버 연결 설정이 없습니다.' }, { status: 503 });
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  // 접속자가 보낸 같은 이름의 헤더는 덮어써서 꾸밀 수 없게 한다.
  headers.set('X-Doneline-Proxy', env.PROXY_SECRET);
  // CF-Connecting-IP: Cloudflare가 확인한 실제 접속자 IP. 백엔드의 로그인·가입 시도 제한 기준이 된다.
  headers.set('X-Doneline-Client-IP', request.headers.get('CF-Connecting-IP') || '');
  headers.set('X-Forwarded-Proto', 'https');
  headers.delete('Host');
  // 서버가 꺼져 있을 때의 안내. 시연할 때만 서버를 켜므로(scripts/demo.ps1·demo-stop.ps1) 고장이 아니라는 점을 알린다.
  const offline = () =>
    Response.json(
      { message: '지금은 시연 서버가 꺼져 있습니다. 시연 시간에 다시 접속해 주세요.' },
      { status: 503 },
    );
  try {
    // redirect: 'manual' — 백엔드 응답(쿠키 포함)을 바꾸지 않고 그대로 브라우저에 돌려준다.
    const res = await fetch(env.BACKEND_ORIGIN + url.pathname + url.search, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
    });
    // 502·504: 공개 입구(Funnel)는 열려 있는데 서버가 꺼진 경우 Tailscale이 돌려주는 응답. 백엔드 자신은 이 값을 쓰지 않는다.
    return res.status === 502 || res.status === 504 ? offline() : res;
  } catch {
    // 공개 입구까지 닫혀 있거나(시연 끝) 서버 PC가 꺼진 경우.
    return offline();
  }
}
