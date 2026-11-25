param(
    [string]$ApkPath = "",
    [string]$AvdName = ""
)

$ErrorActionPreference = "Stop"

function Resolve-AndroidCli {
    $cmd = Get-Command android -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $fallback = Join-Path $env:USERPROFILE "AppData\AndroidCLI\android.exe"
    if (Test-Path $fallback) { return $fallback }
    throw @"
Android CLI ('android.exe') was not found.
Install it on Windows with:
  curl -fsSL https://dl.google.com/android/cli/latest/windows_x86_64/install.cmd -o "%TEMP%\i.cmd" && "%TEMP%\i.cmd"
Then run:
  android init
"@
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$AndroidCli = Resolve-AndroidCli

if (-not $ApkPath) {
    $x86 = Join-Path $PSScriptRoot "dist\BookReader-android-x86_64.apk"
    $uni = Join-Path $PSScriptRoot "dist\BookReader-android-universal.apk"
    if (Test-Path $x86) { $ApkPath = $x86 }
    elseif (Test-Path $uni) { $ApkPath = $uni }
    else {
        throw @"
No x86_64 or universal APK found under android\dist\.
Download 'android-apk-x86_64' from GitHub Actions CI and pass:
  .\android\run_in_emulator.ps1 -ApkPath C:\path\to\BookReader-android-x86_64.apk
"@
    }
}

if (-not (Test-Path $ApkPath)) {
    throw "APK not found at: $ApkPath"
}

Write-Host "Using Android CLI: $AndroidCli"
Write-Host "Using APK: $ApkPath"

if (-not $AvdName) {
    $avdList = & $AndroidCli emulator list 2>&1 | Out-String
    $lines = $avdList -split "`r?`n" | Where-Object { $_.Trim() -ne "" }
    if ($avdList -match "medium_phone") {
        $AvdName = "medium_phone"
    } elseif ($lines.Count -gt 0 -and $lines[0] -match "^\s*([A-Za-z0-9._-]+)") {
        $AvdName = $Matches[1]
    } else {
        Write-Host "Creating default x86_64 emulator AVD 'medium_phone'..."
        & $AndroidCli emulator create medium_phone
        if ($LASTEXITCODE -ne 0) {
            throw "Failed creating AVD. Run 'android emulator create --list-profiles' or create one in Android Device Hub."
        }
        $AvdName = "medium_phone"
    }
}

Write-Host "Starting emulator '$AvdName' (if not already running)..."
& $AndroidCli emulator start $AvdName
if ($LASTEXITCODE -ne 0) {
    throw "Failed starting emulator '$AvdName'."
}

Write-Host "Installing APK onto emulator..."
& $AndroidCli install --apks $ApkPath
if ($LASTEXITCODE -ne 0) {
    throw "Failed installing APK '$ApkPath'."
}

Write-Host "Launching BookReader..."
& $AndroidCli run --apks $ApkPath --activity com.bookreader.android/.MainActivity
if ($LASTEXITCODE -ne 0) {
    Write-Host "Installed! Open BookReader from the emulator launcher or Android Device Hub Mirror."
} else {
    Write-Host "BookReader launched! Open the Android Device Hub pane and click Mirror to interact live."
}
