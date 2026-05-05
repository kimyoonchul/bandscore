# BandScore 서버 + ngrok 실행 스크립트
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:PATH = "C:\Program Files\nodejs;" + $env:PATH

# 자동 git pull (서버 시작 전 최신 코드 동기화)
Write-Host "🔄 최신 코드 동기화 중 (git pull)..." -ForegroundColor Yellow
Push-Location $scriptDir
try {
    $pullResult = git pull origin master 2>&1
    if ($pullResult -match "Already up to date") {
        Write-Host "✅ 이미 최신 상태입니다." -ForegroundColor Green
    } else {
        Write-Host "✅ 최신 코드를 받았습니다:" -ForegroundColor Green
        Write-Host $pullResult -ForegroundColor Cyan
    }
} catch {
    Write-Host "⚠️ git pull 실패 (오프라인?). 기존 코드로 시작합니다." -ForegroundColor Yellow
}
Pop-Location

Write-Host "🎵 BandScore 서버 시작 중..." -ForegroundColor Yellow

# Start Node server
$nodeProc = Start-Process -FilePath "C:\Program Files\nodejs\node.exe" -ArgumentList "$scriptDir\server.js" -PassThru -NoNewWindow
Start-Sleep -Seconds 2

Write-Host "✅ 서버 실행 중: http://localhost:3000" -ForegroundColor Green

# Start ngrok
$ngrokPath = Join-Path $scriptDir "ngrok.exe"
if (Test-Path $ngrokPath) {
    Write-Host "🌐 ngrok 터널 시작 중..." -ForegroundColor Yellow
    $ngrokProc = Start-Process -FilePath $ngrokPath -ArgumentList "http 3000" -PassThru -NoNewWindow
    Start-Sleep -Seconds 3
    try {
        $tunnels = Invoke-RestMethod -Uri "http://127.0.0.1:4040/api/tunnels" -TimeoutSec 5
        $publicUrl = $tunnels.tunnels[0].public_url
        Write-Host "🌍 외부 접속: $publicUrl" -ForegroundColor Cyan
    } catch {
        Write-Host "⚠️ ngrok URL을 가져올 수 없습니다. http://127.0.0.1:4040 에서 확인하세요" -ForegroundColor Yellow
    }
} else {
    Write-Host "⚠️ ngrok.exe가 없습니다. 로컬에서만 접속 가능합니다." -ForegroundColor Yellow
}

Write-Host "`n종료하려면 Ctrl+C를 누르세요" -ForegroundColor Gray
try { $nodeProc.WaitForExit() } catch {}
