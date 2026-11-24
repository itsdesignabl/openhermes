<#
Removes OpenHermes: stops the gateway, removes the startup entry and the PATH
entry, then deletes the home folder with the program, vault, memory and keys.

  powershell -ExecutionPolicy Bypass -File "C:\Openhermes Programming Files\uninstall.ps1"
#>
param(
  [string]$HomePath = $(if ($env:OPENHERMES_HOME) { $env:OPENHERMES_HOME } elseif ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'vault'))) { $PSScriptRoot } else { Join-Path $env:SystemDrive 'Openhermes Programming Files' }),
  [switch]$Yes
)
$ErrorActionPreference = 'Stop'
$HomePath = [IO.Path]::GetFullPath($HomePath).TrimEnd('\')

if (-not (Test-Path (Join-Path $HomePath 'vault'))) { throw "No OpenHermes installation found at $HomePath" }
if (-not $Yes) {
  $answer = Read-Host "Delete $HomePath with the agent's notes, memory and keys? This cannot be undone. Type yes to continue"
  if ($answer -ne 'yes') { Write-Host 'Nothing was removed.'; return }
}

$launcher = Join-Path $HomePath 'openhermes.cmd'
if (Test-Path $launcher) {
  $ErrorActionPreference = 'Continue'
  & $launcher gateway stop 2>&1 | Out-Null
  & $launcher autostart off 2>&1 | Out-Null
  $ErrorActionPreference = 'Stop'
}

# take the home folder off the user's PATH, leaving every other entry as it was
$key = Get-Item 'HKCU:\Environment'
$old = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
$kept = @($old -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ne $HomePath) })
if (($kept -join ';') -ne $old) {
  Set-ItemProperty 'HKCU:\Environment' -Name Path -Value ($kept -join ';') -Type ExpandString
  # tells running programs that the environment changed
  [Environment]::SetEnvironmentVariable('OPENHERMES_REFRESH', $null, 'User')
}

Set-Location $env:TEMP
for ($i = 0; $i -lt 10 -and (Test-Path $HomePath); $i++) {
  try { Remove-Item -LiteralPath $HomePath -Recurse -Force -ErrorAction Stop } catch { Start-Sleep -Milliseconds 700 }
}
if (Test-Path $HomePath) { throw "Could not delete all of $HomePath. Close programs that use it (Obsidian, a terminal inside it) and delete the folder by hand." }
Write-Host "OpenHermes was removed from $HomePath."
Write-Host 'Not removed: Ollama, Obsidian or Docker if you installed them, and bots you registered with Telegram, Discord or Slack.'
