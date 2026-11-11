<#
 Instala o player Enif OOH num mini PC Windows.
 Executar no PowerShell, como administrador:
   .\instalar-player-windows.ps1 -Servidor "http://192.168.1.50:8080" -Codigo "ECR-001" -Chave "abcdef123456"
 Faz: página do player em ecrã inteiro (Microsoft Edge), arranque automático com o Windows,
 reinício automático se o Edge fechar, e desliga a suspensão do PC e do ecrã.
#>
param(
  [Parameter(Mandatory = $true)][string]$Servidor,
  [Parameter(Mandatory = $true)][string]$Codigo,
  [Parameter(Mandatory = $true)][string]$Chave
)
$ErrorActionPreference = 'Stop'
$Servidor = $Servidor.TrimEnd('/')
# procura o Edge (instalado para todos, só para o utilizador, ou registado no Windows) e, em último caso, o Google Chrome
$cands = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe", "$env:LocalAppData\Microsoft\Edge\Application\msedge.exe")
foreach ($k in 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe', 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe') {
  try { $v = (Get-ItemProperty -Path $k -ErrorAction Stop).'(default)'; if ($v) { $cands += $v } } catch { }
}
$cands += @("${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "$env:LocalAppData\Google\Chrome\Application\chrome.exe")
$edge = $cands | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $edge) { throw 'Não encontrei o Microsoft Edge nem o Google Chrome neste PC. Instala o Edge (https://www.microsoft.com/edge) e corre este comando outra vez.' }
Write-Host "Navegador encontrado: $edge"

$dir = 'C:\EnifPlayer'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$url = "$Servidor/player/?code=$Codigo&key=$Chave"

# script de arranque: volta a abrir o Edge se ele fechar ou falhar
$bat = @"
@echo off
:loop
"$edge" --kiosk "$url" --edge-kiosk-type=fullscreen --no-first-run --no-default-browser-check --autoplay-policy=no-user-gesture-required --unsafely-treat-insecure-origin-as-secure="$Servidor" --user-data-dir="$dir\profile" --disable-pinch --overscroll-history-navigation=0
timeout /t 5 /nobreak >nul
goto loop
"@
Set-Content -Path "$dir\player.bat" -Value $bat -Encoding ASCII

# arranque automático para todos os utilizadores
$startup = "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\StartUp"
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut("$startup\EnifPlayer.lnk")
$lnk.TargetPath = "$dir\player.bat"
$lnk.WindowStyle = 7
$lnk.Save()

# nunca suspender nem desligar o ecrã
powercfg /change standby-timeout-ac 0
powercfg /change monitor-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /hibernate off

Write-Host ''
Write-Host 'Instalação concluída.' -ForegroundColor Green
Write-Host "Endereço do player: $url"
Write-Host 'Para testar agora: reinicie o PC (o player abre sozinho) ou execute C:\EnifPlayer\player.bat'
Write-Host 'Dica: no ecrã, carregue na tecla D para ver o estado do player.'
Write-Host 'Recomendado: ligar o início de sessão automático do Windows (netplwiz) para o PC arrancar sozinho após falhas de energia.'
