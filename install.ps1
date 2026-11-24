<#
Installs OpenHermes on Windows.

Everything goes into one folder (default C:\Openhermes Programming Files). The
only things written outside it are an entry on your PATH so the `openhermes`
command works in every terminal, and, if you ask for it, a startup entry.

From the web:
  irm https://raw.githubusercontent.com/itsdesignabl/openhermes/main/install.ps1 | iex

From a downloaded copy, with options:
  powershell -ExecutionPolicy Bypass -File install.ps1 -Autostart

Options
  -HomePath <folder>   where to install
  -Package <zip|link>  install this release package instead of the latest one
  -Source <zip|link>   build from this source archive instead of using a release package
  -Node auto|system|bundled
                       auto: use Node.js 22.13 or newer if it is installed, otherwise
                       download a private copy into the home folder
  -Autostart           start the gateway each time you log in
  -NoPath              do not add the folder to your PATH
#>
param(
  [string]$HomePath = $(if ($env:OPENHERMES_HOME) { $env:OPENHERMES_HOME } else { Join-Path $env:SystemDrive 'Openhermes Programming Files' }),
  [string]$Package = '',
  [string]$Source = '',
  [ValidateSet('auto', 'system', 'bundled')][string]$Node = 'auto',
  [switch]$Autostart,
  [switch]$NoPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # the progress bar makes downloads many times slower
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repository = 'itsdesignabl/openhermes'
$ReleaseZip = "https://github.com/$Repository/releases/latest/download/openhermes.zip"
$SourceZip = "https://github.com/$Repository/archive/refs/heads/main.zip"
$MinNode = [version]'22.13.0'

function Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }

# Runs a program and stops the install if it fails. Programs that print warnings
# to the error stream must not be mistaken for failures.
function Run($exe, [string[]]$arguments) {
  $saved = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $exe @arguments } finally { $ErrorActionPreference = $saved }
  if ($LASTEXITCODE -ne 0) { throw "$(Split-Path $exe -Leaf) $($arguments -join ' ') failed (exit code $LASTEXITCODE)." }
}

function Fetch($from, $to) {
  if ($from -match '^https?://') { Invoke-WebRequest -Uri $from -OutFile $to -UseBasicParsing }
  else { Copy-Item -LiteralPath $from -Destination $to -Force }
}

function Unzip($zip, $dest) {
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (Test-Path $tar) { Run $tar @('-xf', $zip, '-C', $dest) }   # much faster than Expand-Archive
  else { Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force }
}

function NodeVersion($exe) {
  try { return [version]((& $exe --version) -replace '^v', '') } catch { return $null }
}

$HomePath = [IO.Path]::GetFullPath($HomePath).TrimEnd('\')
$runtime = Join-Path $HomePath 'runtime'
$launcher = Join-Path $HomePath 'openhermes.cmd'
$tmp = Join-Path $HomePath '.install'

Step "Installing OpenHermes into $HomePath"
try {
  New-Item -ItemType Directory -Force -Path $HomePath | Out-Null
  if (Test-Path $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
} catch {
  throw "Could not create $HomePath ($($_.Exception.Message)). Choose another place with -HomePath, for example -HomePath `"$HOME\Openhermes Programming Files`"."
}

# --- Node.js ---------------------------------------------------------------
$nodeDir = Join-Path $HomePath 'node'
$nodeExe = $null
if (Test-Path (Join-Path $nodeDir 'node.exe')) {
  $nodeExe = Join-Path $nodeDir 'node.exe'
} elseif ($Node -ne 'bundled') {
  $found = Get-Command node -ErrorAction SilentlyContinue
  if ($found) {
    $v = NodeVersion $found.Source
    if ($v -and $v -ge $MinNode) { $nodeExe = $found.Source; Step "Using Node.js $v from $($found.Source)" }
    elseif ($Node -eq 'system') { throw "Node.js $v is installed, but $MinNode or newer is needed." }
  } elseif ($Node -eq 'system') { throw 'Node.js is not installed. Install it, or leave out -Node system to get a private copy.' }
}
if (-not $nodeExe) {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
  Step "Downloading a private copy of Node.js ($arch) into $nodeDir"
  $base = 'https://nodejs.org/dist/latest-v22.x'
  $sums = Join-Path $tmp 'SHASUMS256.txt'
  Fetch "$base/SHASUMS256.txt" $sums
  $line = Get-Content $sums | Where-Object { $_ -match "\snode-v[\d.]+-win-$arch\.zip$" } | Select-Object -First 1
  if (-not $line) { throw "No Node.js download for Windows $arch was found at $base." }
  $expected, $name = $line -split '\s+', 2
  $zip = Join-Path $tmp $name
  Fetch "$base/$name" $zip
  $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
  if ($actual -ne $expected) { throw "The Node.js download is damaged (checksum mismatch). Run the installer again." }
  Unzip $zip (Join-Path $tmp 'node')
  Move-Item -LiteralPath (Join-Path $tmp ("node\" + ($name -replace '\.zip$', ''))) -Destination $nodeDir
  $nodeExe = Join-Path $nodeDir 'node.exe'
}
# npm and anything it starts must find this Node.js first
$env:Path = (Split-Path $nodeExe) + ';' + $env:Path

# --- The program -----------------------------------------------------------
$cli = Join-Path $runtime 'dist\src\cli.js'
if (Test-Path $cli) {
  Step 'OpenHermes is already installed here; updating it'
  $arguments = @($cli, 'update', '--home', $HomePath)
  if ($Package) { $arguments += @('--from', $Package, '--force') }
  if ($Package -or -not (Test-Path (Join-Path $runtime '.git')) -or (Get-Command git -ErrorAction SilentlyContinue)) {
    $saved = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    & $nodeExe @arguments
    $ErrorActionPreference = $saved
    if ($LASTEXITCODE -ne 0) { Write-Warning 'The update did not complete. The installed version was kept.' }
  }
} else {
  if (Test-Path $runtime) {
    if (@(Get-ChildItem -LiteralPath $runtime -Force).Count) { throw "$runtime exists but holds no working program. Move it away or delete it, then run the installer again." }
    Remove-Item -LiteralPath $runtime -Force
  }
  $zip = Join-Path $tmp 'openhermes.zip'
  $fromSource = [bool]$Source
  if (-not $fromSource) {
    $from = if ($Package) { $Package } else { $ReleaseZip }
    Step "Getting the program from $from"
    try { Fetch $from $zip }
    catch {
      if ($Package) { throw "Could not get the package: $($_.Exception.Message)" }
      Write-Host '    No release package is available; building from the source instead (takes a few minutes).'
      $fromSource = $true
    }
  }
  $stage = Join-Path $tmp 'program'
  if (-not $fromSource) {
    Unzip $zip $stage
  } else {
    $from = if ($Source) { $Source } else { $SourceZip }
    Step "Getting the source from $from"
    Fetch $from $zip
    $unpacked = Join-Path $tmp 'source'
    Unzip $zip $unpacked
    # an archive from GitHub wraps everything in one folder
    $inner = @(Get-ChildItem -LiteralPath $unpacked -Force)
    $stage = if ($inner.Count -eq 1 -and $inner[0].PSIsContainer) { $inner[0].FullName } else { $unpacked }
    $npm = Join-Path (Split-Path $nodeExe) 'npm.cmd'
    if (-not (Test-Path $npm)) { throw 'npm was not found next to Node.js, so the source cannot be built.' }
    Step 'Building (npm ci, npm run build)'
    Push-Location $stage
    try {
      Run $npm @('ci', '--no-audit', '--no-fund')
      Run $npm @('run', 'build')
    } finally { Pop-Location }
  }
  if (-not (Test-Path (Join-Path $stage 'dist\src\cli.js'))) { throw 'The download does not contain the program (dist\src\cli.js is missing).' }
  Move-Item -LiteralPath $stage -Destination $runtime

  Step 'Creating the vault'
  Run $nodeExe @($cli, 'init', '--home', $HomePath)
}

$uninstaller = Join-Path $runtime 'uninstall.ps1'
if (Test-Path $uninstaller) { Copy-Item -LiteralPath $uninstaller -Destination (Join-Path $HomePath 'uninstall.ps1') -Force }
Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue

# --- The `openhermes` command ---------------------------------------------
if (-not $NoPath) {
  # read and write the raw value, so entries like %USERPROFILE%\bin stay as they are
  $key = Get-Item 'HKCU:\Environment'
  $old = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
  if (-not ($old -split ';' | Where-Object { $_.TrimEnd('\') -eq $HomePath })) {
    Step 'Adding the folder to your PATH'
    $new = (@($old -split ';' | Where-Object { $_ }) + $HomePath) -join ';'
    Set-ItemProperty 'HKCU:\Environment' -Name Path -Value $new -Type ExpandString
    # tells running programs that the environment changed
    [Environment]::SetEnvironmentVariable('OPENHERMES_REFRESH', $null, 'User')
  }
  if (-not ($env:Path -split ';' | Where-Object { $_.TrimEnd('\') -eq $HomePath })) { $env:Path = $env:Path + ';' + $HomePath }
}

if ($Autostart) {
  Step 'Setting the gateway to start when you log in'
  Run $launcher @('autostart', 'on')
}

Step 'Installed'
Run $launcher @('version')
Write-Host ''
Write-Host 'Next:'
Write-Host '  1. Connect a model. The quickest way is Ollama: https://ollama.com'
Write-Host "     Then set base_url and model in $HomePath\vault\System\config.md"
Write-Host '  2. openhermes doctor     checks the setup'
Write-Host '  3. openhermes chat       talk to your agent'
if (-not $NoPath) { Write-Host 'Open a new terminal window if the openhermes command is not found in this one.' }
Write-Host "To remove everything later: powershell -ExecutionPolicy Bypass -File `"$HomePath\uninstall.ps1`""
