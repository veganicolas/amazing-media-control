param(
    [string]$Target = $(if ($env:AMC_DEPLOY_TARGET) { $env:AMC_DEPLOY_TARGET } else { "admin@192.168.151.131" }),
    [string]$RemoteDir = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

$TargetDirSetup = if ([string]::IsNullOrWhiteSpace($RemoteDir)) {
    'd=$(xdg-user-dir DESKTOP 2>/dev/null); d="${d:-$HOME/Desktop}/amazing-media-control@local"'
} else {
    "d=`"${RemoteDir}`""
}
$RemoteCmd = $TargetDirSetup + '; rm -rf "${d}/src" "${d}/schemas" && mkdir -p "${d}" && tar -xzf - -C "${d}" && glib-compile-schemas "${d}/schemas" && chmod +x "${d}"/scripts/*.sh && echo "Sent to ${d}"'

$TempArchive = Join-Path ([System.IO.Path]::GetTempPath()) "amc-deploy-$PID.tar.gz"
try {
    & tar -czf $TempArchive -C $RepoRoot metadata.json extension.js prefs.js stylesheet.css schemas src scripts README.md
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }

    Write-Host "Deploying to $Target Desktop (single SSH connection)..."
    $Proc = Start-Process -FilePath "ssh" -ArgumentList @($Target, $RemoteCmd) -RedirectStandardInput $TempArchive -NoNewWindow -Wait -PassThru
    if ($Proc.ExitCode -ne 0) {
        exit $Proc.ExitCode
    }
} finally {
    if (Test-Path -LiteralPath $TempArchive) {
        Remove-Item -LiteralPath $TempArchive -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "Deploy complete! Inside your VM, run ./scripts/install.sh from that Desktop folder when ready."
