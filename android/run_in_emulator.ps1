param(
    [string]$ApkPath = "",
    [string]$AvdName = ""
)

$ErrorActionPreference = "Stop"

function Invoke-NativeSafe {
    param(
        [Parameter(Mandatory = $true)][string]$Exe,
        [string[]]$CommandArgs = @()
    )
    $prevEap = $ErrorActionPreference
    $hasNativePref = Test-Path variable:PSNativeCommandUseErrorActionPreference
    $prevNativePref = if ($hasNativePref) { $PSNativeCommandUseErrorActionPreference } else { $false }
    try {
        $ErrorActionPreference = "Continue"
        if ($hasNativePref) { $PSNativeCommandUseErrorActionPreference = $false }
        $out = (& $Exe @CommandArgs 2>&1 | Out-String)
        $code = $LASTEXITCODE
        return [pscustomobject]@{ Output = $out; ExitCode = $code }
    } finally {
        $ErrorActionPreference = $prevEap
        if ($hasNativePref) { $PSNativeCommandUseErrorActionPreference = $prevNativePref }
    }
}

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
    $avdRes = Invoke-NativeSafe -Exe $AndroidCli -CommandArgs @("emulator", "list")
    if ($avdRes.ExitCode -ne 0) {
        throw "Failed listing AVDs: $($avdRes.Output)"
    }
    $lines = @($avdRes.Output -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match "^[A-Za-z0-9._-]+$" })
    if ($lines -contains "medium_phone") {
        $AvdName = "medium_phone"
    } elseif ($lines.Count -gt 0) {
        $AvdName = $lines[0]
    } else {
        Write-Host "Creating default x86_64 emulator AVD 'medium_phone'..."
        & $AndroidCli emulator create medium_phone
        if ($LASTEXITCODE -ne 0) {
            throw "Failed creating AVD. Run 'android emulator create --list-profiles' or create one in Android Device Hub."
        }
        $AvdName = "medium_phone"
    }
}

$adbExe = Get-Command adb -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
foreach ($sdkCand in @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, (Join-Path $env:LOCALAPPDATA "Android\Sdk"))) {
    if ($adbExe) { break }
    if ($sdkCand) {
        $cand = Join-Path $sdkCand "platform-tools\adb.exe"
        if (Test-Path $cand) { $adbExe = $cand }
    }
}
$emuSerial = $null
if ($adbExe -and (Test-Path $adbExe)) {
    $devRes = Invoke-NativeSafe -Exe $adbExe -CommandArgs @("devices")
    if ($devRes.ExitCode -eq 0 -and $devRes.Output -match "(emulator-\d+)\s+device") {
        $emuSerial = $Matches[1]
    }
}
if ($emuSerial) {
    Write-Host "Emulator '$emuSerial' already running; reusing active device."
} else {
    Write-Host "Starting emulator '$AvdName' (if not already running)..."
    & $AndroidCli emulator start $AvdName
    if ($LASTEXITCODE -ne 0) {
        throw "Failed starting emulator '$AvdName'."
    }
    if ($adbExe -and (Test-Path $adbExe)) {
        $devRes = Invoke-NativeSafe -Exe $adbExe -CommandArgs @("devices")
        if ($devRes.ExitCode -eq 0 -and $devRes.Output -match "(emulator-\d+)\s+device") {
            $emuSerial = $Matches[1]
        }
    }
}

Write-Host "Installing and launching BookReader on emulator..."
$runRes = Invoke-NativeSafe -Exe $AndroidCli -CommandArgs @("run", "--apks", $ApkPath)
if ($runRes.ExitCode -ne 0) {
    if ($adbExe -and (Test-Path $adbExe) -and $emuSerial) {
        Write-Host "Uninstalling existing com.bookreader.android (e.g. different CI debug key) and retrying..."
        Invoke-NativeSafe -Exe $adbExe -CommandArgs @("-s", $emuSerial, "uninstall", "com.bookreader.android") | Out-Null
    }
    $runRes = Invoke-NativeSafe -Exe $AndroidCli -CommandArgs @("run", "--apks", $ApkPath)
}
if ($runRes.ExitCode -ne 0) {
    Write-Host "Falling back to direct install + launcher intent..."
    $instRes = Invoke-NativeSafe -Exe $AndroidCli -CommandArgs @("install", "--apks", $ApkPath)
    if ($instRes.ExitCode -ne 0) {
        throw "Failed installing APK '$ApkPath': $($instRes.Output)"
    }
    if (-not ($adbExe -and (Test-Path $adbExe))) {
        throw "Installed APK, but 'adb.exe' was not found to launch com.bookreader.android."
    }
    $adbArgs = if ($emuSerial) { @("-s", $emuSerial) } else { @() }
    $launchRes = Invoke-NativeSafe -Exe $adbExe -CommandArgs ($adbArgs + @("shell", "monkey", "-p", "com.bookreader.android", "-c", "android.intent.category.LAUNCHER", "1"))
    if ($launchRes.ExitCode -ne 0) {
        throw "Installed APK, but failed launching com.bookreader.android launcher activity: $($launchRes.Output)"
    }
}
Write-Host "BookReader launched! Open the Android Device Hub pane and click Mirror to interact live."
exit 0
