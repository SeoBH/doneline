# Doneline 외부 데모 실행 스크립트.
# 이 PC의 Doneline 서버(127.0.0.1:3100)를 Tailscale Funnel로 공개하고 데모 설정으로 서버를 실행한다.
# 기본(Pages 중계 모드): 사용자는 https://doneline.pages.dev 로 접속하고, Pages 중계 함수만 Funnel 주소로 서버에 들어온다.
#   서버는 .env의 PROXY_SECRET 표식이 붙은 요청만 받으므로 ts.net 주소로 직접 들어오면 거절된다(scripts/deploy-pages.ps1 참고).
# -Direct: 예전처럼 https://<이 PC의 Tailscale 이름>.ts.net 으로 직접 접속하게 한다(중계 표식 검사 끔).
# Ctrl+C로 서버를 멈추면 공개 연결(Funnel)도 함께 닫는다. 창을 X로 닫으면 닫히지 않으므로 scripts/demo-stop.ps1을 실행한다.
# 실행: powershell -ExecutionPolicy Bypass -File scripts/demo.ps1   (프로젝트 루트에서, 빌드 후)
#   -Sample: 시연 모드. 시연 DB(doneline_demo)를 예시 데이터로 새로 만든 뒤(backend/demo-seed.cjs) 그 DB로 연다.
#            로그인 화면에 시연 계정 창이 뜨고(.env.demo), 메일·슬랙은 보내지 않는다.
#   -NoReset: -Sample과 함께 쓰면 예시 데이터를 다시 만들지 않고 지난 시연 상태 그대로 연다.
param([switch]$Sample, [switch]$NoReset, [switch]$Direct)
$ErrorActionPreference = 'Stop'
$tailscale = 'C:\Program Files\Tailscale\tailscale.exe'
Set-Location (Split-Path $PSScriptRoot -Parent)

# 서버의 허용 출처(사용자가 보는 주소). 서버는 이 출처에서 온 변경 요청만 받고, 메일 링크도 이 주소로 만든다.
$name = ((& $tailscale status --json | ConvertFrom-Json).Self.DNSName).TrimEnd('.')
if ($Direct) {
  $origin = "https://$name"
  # 직접 접속 모드에서는 중계 표식 검사를 끈다(.env 값보다 이 창의 환경변수가 우선한다).
  $env:PROXY_SECRET = ''
} else {
  $origin = 'https://doneline.pages.dev'
}

# NODE_ENV=production: HTTPS 출처 필수, 보안 쿠키 발급, 로컬 메일 미리보기 차단.
# TRUST_PROXY=1: 앞단 프록시(Funnel) 1개가 보내는 X-Forwarded-* 헤더로 실제 접속 IP와 HTTPS 여부를 판단한다(서버는 127.0.0.1에만 열림).
$env:NODE_ENV = 'production'
$env:APP_ORIGIN = $origin
$env:TRUST_PROXY = '1'
$env:NODE_USE_SYSTEM_CA = '1'
# 시연 모드: 접속 DB를 시연 DB로 바꾸고(.env 값보다 이 창의 환경변수가 우선한다) 실제 메일·슬랙 알림을 끈다.
if ($Sample) {
  $env:PGDATABASE = 'doneline_demo'
  $env:SMTP_HOST = ''
  $env:SLACK_WEBHOOK_URL = ''
  if (-not $NoReset -or -not (Test-Path '.env.demo')) {
    Write-Host '시연 데이터를 새로 만듭니다(1분 정도 걸립니다)...'
    node backend/demo-seed.cjs
    if ($LASTEXITCODE) { throw '시연 데이터를 만들지 못했습니다.' }
  }
  # .env.demo의 DEMO_ACCOUNTS 한 줄을 이 창의 환경변수로 넘긴다(서버가 로그인 화면 시연 계정 창에 쓴다).
  $line = Get-Content '.env.demo' -Encoding UTF8 | Where-Object { $_ -like 'DEMO_ACCOUNTS=*' }
  $env:DEMO_ACCOUNTS = $line.Substring('DEMO_ACCOUNTS='.Length)
}

# --bg: Funnel 설정을 Tailscale에 저장해 이 창과 무관하게 유지한다(서버가 꺼져 있으면 접속만 실패).
& $tailscale funnel --bg 3100
Write-Host "Doneline 접속 주소: $origin (서버 입구: https://$name)"
if ($Sample) { Write-Host '시연 모드(doneline_demo)로 실행합니다. 로그인 화면에 시연 계정 창이 뜹니다.' }
Write-Host '끝낼 때는 Ctrl+C를 누르세요(공개 연결도 함께 닫힙니다).'
# finally: Ctrl+C로 서버를 멈춰도 실행되어, 서버가 꺼진 뒤 공개 입구가 열린 채 남지 않게 한다.
try { node backend/dist/main.js }
finally {
  & $tailscale funnel reset
  Write-Host '공개 연결을 닫았습니다.'
}
