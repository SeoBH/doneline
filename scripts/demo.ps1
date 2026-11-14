# Doneline 외부 데모 실행 스크립트.
# 이 PC의 Doneline 서버(127.0.0.1:3100)를 Tailscale Funnel로 공개하고 데모 설정으로 서버를 실행한다.
# 기본(Pages 중계 모드): 사용자는 https://doneline.pages.dev 로 접속하고, Pages 중계 함수만 Funnel 주소로 서버에 들어온다.
#   서버는 .env의 PROXY_SECRET 표식이 붙은 요청만 받으므로 ts.net 주소로 직접 들어오면 거절된다(scripts/deploy-pages.ps1 참고).
# -Direct: 예전처럼 https://<이 PC의 Tailscale 이름>.ts.net 으로 직접 접속하게 한다(중계 표식 검사 끔).
# 창을 닫거나 Ctrl+C로 서버를 멈추면 접속이 끊긴다.
# 공개를 완전히 끄려면: tailscale funnel reset
# 실행: powershell -ExecutionPolicy Bypass -File scripts/demo.ps1   (프로젝트 루트에서, 빌드 후)
#   -Sample: 설명서 촬영용 예시 데이터(doneline_manual: 한빛IT서비스·서울메디랩, 계정 hanbit_ceo 등)로 연다.
#            예시 DB는 npm run manual을 실행하면 처음 상태로 다시 만들어진다.
param([switch]$Sample, [switch]$Direct)
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
# 예시 데이터 선택 시 접속 DB만 바꾼다(.env 값보다 이 창의 환경변수가 우선한다).
if ($Sample) { $env:PGDATABASE = 'doneline_manual' }

# --bg: Funnel 설정을 Tailscale에 저장해 이 창과 무관하게 유지한다(서버가 꺼져 있으면 접속만 실패).
& $tailscale funnel --bg 3100
Write-Host "Doneline 접속 주소: $origin (서버 입구: https://$name)"
if ($Sample) { Write-Host "예시 데이터(doneline_manual)로 실행합니다." }
node backend/dist/main.js
