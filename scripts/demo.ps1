# Doneline 외부 데모 실행 스크립트.
# 이 PC의 Doneline 서버(127.0.0.1:3100)를 Tailscale Funnel로 인터넷에 공개하고 데모 설정으로 서버를 실행한다.
# 공개 주소: https://<이 PC의 Tailscale 이름>.ts.net (고정). 창을 닫거나 Ctrl+C로 서버를 멈추면 접속이 끊긴다.
# 공개를 완전히 끄려면: tailscale funnel reset
# 실행: powershell -ExecutionPolicy Bypass -File scripts/demo.ps1   (프로젝트 루트에서, 빌드 후)
$ErrorActionPreference = 'Stop'
$tailscale = 'C:\Program Files\Tailscale\tailscale.exe'
Set-Location (Split-Path $PSScriptRoot -Parent)

# 이 PC의 Tailscale 주소를 서버의 허용 출처로 쓴다. 서버는 이 출처에서 온 변경 요청만 받는다.
$name = ((& $tailscale status --json | ConvertFrom-Json).Self.DNSName).TrimEnd('.')
$origin = "https://$name"

# NODE_ENV=production: HTTPS 출처 필수, 보안 쿠키 발급, 로컬 메일 미리보기 차단.
# TRUST_PROXY=1: 앞단 프록시(Funnel) 1개가 보내는 X-Forwarded-* 헤더로 실제 접속 IP와 HTTPS 여부를 판단한다(서버는 127.0.0.1에만 열림).
$env:NODE_ENV = 'production'
$env:APP_ORIGIN = $origin
$env:TRUST_PROXY = '1'
$env:NODE_USE_SYSTEM_CA = '1'

# --bg: Funnel 설정을 Tailscale에 저장해 이 창과 무관하게 유지한다(서버가 꺼져 있으면 접속만 실패).
& $tailscale funnel --bg 3100
Write-Host "Doneline 데모 주소: $origin"
node backend/dist/main.js
