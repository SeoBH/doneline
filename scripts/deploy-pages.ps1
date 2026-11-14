# Doneline Cloudflare Pages 배포 스크립트(대표님 Cloudflare 계정으로 실행).
# - 앱(doneline-app.pages.dev): 화면 파일(frontend/dist) + 보안 헤더(deploy/pages/_headers) + API 중계 함수(deploy/pages/functions)
# - 소개 페이지(doneline.pages.dev): landing 폴더
# 처음 한 번: npx.cmd wrangler login (브라우저에서 Cloudflare 로그인·허용) 후 -Setup으로 프로젝트와 비밀값을 만든다.
# 실행(프로젝트 루트에서):
#   powershell -ExecutionPolicy Bypass -File scripts/deploy-pages.ps1 -Setup   # 처음 한 번: 프로젝트 생성 + 비밀값 등록
#   powershell -ExecutionPolicy Bypass -File scripts/deploy-pages.ps1          # 앱과 소개 페이지 모두 배포
#   ... -App / -Landing                                                        # 하나만 배포
# 비밀값은 .env(PROXY_SECRET)와 Tailscale 주소에서 읽어 바로 Cloudflare로 보내며 화면·파일에 남기지 않는다.
param([switch]$Setup, [switch]$App, [switch]$Landing)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
# wrangler: Cloudflare 공식 배포 도구. 버전 4로 고정해 내려받아 실행한다.
function Wrangler { & npx.cmd --yes wrangler@4 @args; if ($LASTEXITCODE) { throw "wrangler $($args[0]) 실패" } }
if (-not ($App -or $Landing -or $Setup)) { $App = $true; $Landing = $true }

if ($Setup) {
  # 이미 있는 프로젝트면 생성 오류를 무시하고 넘어간다.
  foreach ($p in 'doneline-app', 'doneline') {
    & npx.cmd --yes wrangler@4 pages project create $p --production-branch main
  }
  # .env에서 PROXY_SECRET 한 줄만 읽는다(다른 값은 읽지 않는다).
  $secret = (Select-String -Path .env -Pattern '^PROXY_SECRET=(.+)$').Matches[0].Groups[1].Value
  $tailscale = 'C:\Program Files\Tailscale\tailscale.exe'
  $backend = 'https://' + ((& $tailscale status --json | ConvertFrom-Json).Self.DNSName).TrimEnd('.')
  # 파이프로 값을 넘겨 화면에 표시하지 않는다.
  $secret | npx.cmd --yes wrangler@4 pages secret put PROXY_SECRET --project-name doneline-app
  $backend | npx.cmd --yes wrangler@4 pages secret put BACKEND_ORIGIN --project-name doneline-app
  Write-Host '프로젝트와 비밀값을 준비했습니다. 이어서 배포합니다.'
  $App = $true; $Landing = $true
}

if ($App) {
  # 화면을 새로 빌드하고, 화면 파일과 보안 헤더를 배포용 폴더(deploy/pages/dist-app, Git 제외)에 모은다.
  npm.cmd run build --prefix frontend
  $out = Join-Path $root 'deploy/pages/dist-app'
  if (Test-Path $out) { Remove-Item -Recurse -Force $out }
  Copy-Item -Recurse (Join-Path $root 'frontend/dist') $out
  Copy-Item (Join-Path $root 'deploy/pages/_headers') $out
  # wrangler는 실행 위치의 functions 폴더를 함께 올리므로 deploy/pages에서 실행한다.
  Push-Location (Join-Path $root 'deploy/pages')
  try { Wrangler pages deploy dist-app --project-name doneline-app --branch main --commit-dirty=true }
  finally { Pop-Location }
}

if ($Landing) {
  # 소개 페이지에는 중계 함수가 붙지 않도록 landing 폴더 안에서 실행한다.
  Push-Location (Join-Path $root 'landing')
  try { Wrangler pages deploy . --project-name doneline --branch main --commit-dirty=true }
  finally { Pop-Location }
}
