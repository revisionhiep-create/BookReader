$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $RepoRoot
try {
    $hasCuda = $false
    if ($env:CUDA_PATH -and (Test-Path (Join-Path $env:CUDA_PATH "bin\nvcc.exe"))) {
        $hasCuda = $true
    } elseif (Get-Command nvcc -ErrorAction SilentlyContinue) {
        $hasCuda = $true
    }

    $featuresArg = @()
    if ($hasCuda) {
        Write-Host "CUDA Toolkit detected -> building with qwen-cuda (delay-loaded, safe on CPU-only PCs)"
        $featuresArg = @("--features", "qwen-cuda")
    } else {
        Write-Host "CUDA Toolkit not detected -> building CPU release"
    }

    npx tauri build --no-bundle --config windows/tauri.windows.conf.json @featuresArg
    if ($LASTEXITCODE -ne 0) {
        throw "tauri build failed with exit code $LASTEXITCODE"
    }

    $builtExe = Join-Path $RepoRoot "src-tauri\target\release\BookReader.exe"
    $destExe = Join-Path $PSScriptRoot "BookReader.exe"
    if (-not (Test-Path $builtExe)) {
        throw "Expected binary not found at $builtExe"
    }

    Copy-Item -Force $builtExe $destExe
    Write-Host "Copied Windows portable binary to $destExe"
}
finally {
    Pop-Location
}
