# agentwatch one-liner for Windows PowerShell:
#   iwr https://raw.githubusercontent.com/piemvibes-hue/agentwatch/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$dir = Join-Path $HOME '.agentwatch\app'
if (Test-Path $dir) { git -C $dir pull --ff-only } else { git clone https://github.com/piemvibes-hue/agentwatch.git $dir }
node (Join-Path $dir 'src\cli.js') install
Write-Host "`nagentwatch is watching. Dashboard: http://127.0.0.1:8787  (uninstall: node $dir\src\cli.js uninstall)"
