@echo off
setlocal
set "TARGET=%~1"
if "%TARGET%"=="" set "TARGET=%AMC_DEPLOY_TARGET%"
if "%TARGET%"=="" set "TARGET=admin@192.168.151.131"
for %%I in ("%~dp0..") do set "REPO_ROOT=%%~fI"

echo Deploying to %TARGET% Desktop (single SSH connection)...
tar -czf - -C "%REPO_ROOT%" metadata.json extension.js prefs.js stylesheet.css schemas src scripts README.md | ssh "%TARGET%" "d=$(xdg-user-dir DESKTOP 2>/dev/null); d=\"${d:-$HOME/Desktop}/amazing-media-control@local\"; rm -rf \"${d}/src\" \"${d}/schemas\" && mkdir -p \"${d}\" && tar -xzf - -C \"${d}\" && glib-compile-schemas \"${d}/schemas\" && chmod +x \"${d}\"/scripts/*.sh && echo \"Sent to ${d}\""
if errorlevel 1 exit /b %errorlevel%

echo Deploy complete! Inside your VM, run ./scripts/install.sh from that Desktop folder when ready.
