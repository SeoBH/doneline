# Doneline 시연 끝내기: 공개 연결(Tailscale Funnel)을 닫고 이 PC의 Doneline 서버(127.0.0.1:3100)를 멈춘다.
# scripts/demo.ps1 창을 X로 닫아 Ctrl+C 정리가 실행되지 않았을 때, 또는 지금 열려 있는지 모를 때 실행한다.
# 실행: powershell -ExecutionPolicy Bypass -File scripts/demo-stop.ps1
# 끈 뒤 doneline.pages.dev 화면은 열리지만 로그인하면 '시연 서버가 꺼져 있습니다' 안내가 뜬다.
$tailscale = 'C:\Program Files\Tailscale\tailscale.exe'
& $tailscale funnel reset
Write-Host '공개 연결을 닫았습니다.'
# 3100 포트에서 접속을 기다리는 프로세스(= Doneline 서버)만 골라 멈춘다. 다른 node 프로그램은 건드리지 않는다.
$ids = Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique
if ($ids) {
  $ids | ForEach-Object { Stop-Process -Id $_ -Force }
  Write-Host '서버를 멈췄습니다.'
} else {
  Write-Host '실행 중인 서버가 없습니다.'
}
