# Doneline Cloudflare Pages 배포 스크립트(대표님 Cloudflare 계정으로 실행).
# - 앱(doneline.pages.dev): 화면 파일(frontend/dist) + 보안 헤더(deploy/pages/_headers) + API 중계 함수(deploy/pages/functions)
# - 소개 페이지(doneline-info.pages.dev): landing 폴더
# 처음 한 번: npx.cmd wrangler login (브라우저에서 Cloudflare 로그인·허용) 후 -Setup으로 프로젝트와 비밀값을 만든다.
# 실행(프로젝트 루트에서):
#   powershell -ExecutionPolicy Bypass -File scripts/deploy-pages.ps1 -Setup   # 처음 한 번: 프로젝트 생성 + 비밀값 등록 + 앱 배포
#   powershell -ExecutionPolicy Bypass -File scripts/deploy-pages.ps1          # 앱과 소개 페이지 모두 배포
#   ... -App / -Landing                                                        # 하나만 배포
#   ... -App -SkipTests                                                        # 급할 때만: 배포 전 화면 검사를 건너뜀
# 앱 배포(-App·-Setup) 전에는 화면 검사(npm run test:browser·test:lookup)를 먼저 돌리고, 하나라도 실패하면 배포하지 않는다.
#   검사는 로컬 PostgreSQL의 doneline_test DB와 Edge 브라우저가 필요하고 몇 분 걸린다. 소개 페이지(-Landing)만 올릴 때는 돌리지 않는다.
# 비밀값은 .env(PROXY_SECRET)와 Tailscale 주소에서 읽어 바로 Cloudflare로 보내며 화면·파일에 남기지 않는다.
param([switch]$Setup, [switch]$App, [switch]$Landing, [switch]$SkipTests)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
# wrangler: Cloudflare 공식 배포 도구. 버전 4로 고정해 내려받아 실행한다.
function Wrangler { & npx.cmd --yes wrangler@4 @args; if ($LASTEXITCODE) { throw "wrangler $($args[0]) 실패" } }
if (-not ($App -or $Landing -or $Setup)) { $App = $true; $Landing = $true }

if ($Setup) {
  # 주의(2026-11 wrangler 4.162): 'pages project create'는 기본으로 Cloudflare Workers 자동 설정으로 넘어가
  # 실행 폴더 전체를 Workers 정적 파일로 올려 버린다(소스 공개 사고). 그래서 ① 빈 임시 폴더에서 ② --force로
  # 기존 Pages에 직접 만든다. --force는 프로젝트를 처음 만들 때만 필요하고, 이후 명령은 Pages로 바로 간다.
  $empty = Join-Path $env:TEMP ('doneline-wrangler-' + [guid]::NewGuid())
  New-Item -ItemType Directory $empty | Out-Null
  Push-Location $empty
  try {
    # 이미 있는 프로젝트면 생성 오류를 무시하고 넘어간다.
    foreach ($p in 'doneline', 'doneline-info') {
      & npx.cmd --yes wrangler@4 pages project create $p --production-branch main --force
    }
  } finally { Pop-Location }
  # .env에서 PROXY_SECRET 한 줄만 읽는다(다른 값은 읽지 않는다).
  $secret = (Select-String -Path .env -Pattern '^PROXY_SECRET=(.+)$').Matches[0].Groups[1].Value
  $tailscale = 'C:\Program Files\Tailscale\tailscale.exe'
  $backend = 'https://' + ((& $tailscale status --json | ConvertFrom-Json).Self.DNSName).TrimEnd('.')
  # 파이프로 값을 넘겨 화면에 표시하지 않는다. 설정 파일이 없는 빈 폴더에서 실행한다.
  Push-Location $empty
  try {
    $secret | npx.cmd --yes wrangler@4 pages secret put PROXY_SECRET --project-name doneline
    $backend | npx.cmd --yes wrangler@4 pages secret put BACKEND_ORIGIN --project-name doneline
  } finally { Pop-Location; Remove-Item -Recurse -Force $empty }
  # 소개 페이지는 외부 공개 시점을 따로 정하므로 -Setup만으로는 앱만 배포한다(필요하면 -Landing을 함께 붙인다).
  Write-Host '프로젝트와 비밀값을 준비했습니다. 이어서 앱을 배포합니다.'
  $App = $true
}

if ($App) {
  if ($SkipTests) {
    Write-Warning '화면 검사를 건너뛰고 배포합니다(-SkipTests). 배포 뒤 npm run test:browser를 꼭 돌려 주세요.'
    # 검사를 건너뛰면 화면 빌드가 안 되어 있으므로 여기서 빌드한다.
    npm.cmd run build --prefix frontend
    if ($LASTEXITCODE) { throw '화면 빌드 실패' }
  } else {
    # npm 같은 외부 명령은 실패해도 $ErrorActionPreference='Stop'으로 멈추지 않으므로 종료 코드($LASTEXITCODE)를 직접 본다.
    # test:browser는 백엔드·화면 빌드를 함께 하므로 따로 빌드하지 않는다(같은 빌드 결과를 배포).
    $started = Get-Date
    npm.cmd run test:browser
    if ($LASTEXITCODE) { throw '화면 검사(test:browser) 실패 — 배포하지 않았습니다.' }
    npm.cmd run test:lookup
    if ($LASTEXITCODE) { throw '화면 검사(test:lookup) 실패 — 배포하지 않았습니다.' }
    Write-Host ('화면 검사 통과({0:N0}초). 배포를 계속합니다.' -f ((Get-Date) - $started).TotalSeconds)
  }
  # 빌드된 화면 파일과 보안 헤더를 배포용 폴더(deploy/pages/dist-app, Git 제외)에 모은다.
  $out = Join-Path $root 'deploy/pages/dist-app'
  if (Test-Path $out) { Remove-Item -Recurse -Force $out }
  Copy-Item -Recurse (Join-Path $root 'frontend/dist') $out
  Copy-Item (Join-Path $root 'deploy/pages/_headers') $out
  # wrangler는 실행 위치의 functions 폴더를 함께 올리므로 deploy/pages에서 실행한다.
  Push-Location (Join-Path $root 'deploy/pages')
  try { Wrangler pages deploy dist-app --project-name doneline --branch main --commit-dirty=true }
  finally { Pop-Location }
}

if ($Landing) {
  # 소개 페이지에는 중계 함수가 붙지 않도록 landing 폴더 안에서 실행한다.
  Push-Location (Join-Path $root 'landing')
  try { Wrangler pages deploy . --project-name doneline-info --branch main --commit-dirty=true }
  finally { Pop-Location }
}
