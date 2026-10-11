# One-off: creates the PML Snagging tables in PlanetScale.
# Makes a temporary admin login (expires in 15 minutes), creates the tables with it, then deletes it.
# The password is only held in memory; it's never printed or saved.
#   powershell -ExecutionPolicy Bypass -File db\create-tables.ps1
$ErrorActionPreference = 'Stop'
$env:PATH = "$env:USERPROFILE\scoop\apps\nodejs-lts\current;$env:USERPROFILE\scoop\shims;$env:PATH"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$name = "tables-setup-" + (Get-Date -Format 'yyyyMMddHHmmss')

Push-Location (Join-Path $here '..')
try {
  if (-not (Test-Path node_modules\postgres)) { npm install --no-audit --no-fund --silent }
  Write-Host "Creating temporary admin login $name (expires in 15 minutes)..." -ForegroundColor Yellow
  $role = pscale role create pml-snagging main $name --inherited-roles postgres --ttl 15m --org austinleivers --format json | ConvertFrom-Json
  try {
    $env:DATABASE_URL = $role.database_url
    node db/create-tables.mjs
  } finally {
    Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
    # The tables belong to whoever created them, so hand them to the main postgres role first.
    pscale role reassign pml-snagging main $role.id --successor postgres --org austinleivers --force | Out-Null
    Write-Host "Deleting temporary login $name..." -ForegroundColor Yellow
    pscale role delete pml-snagging main $role.id --org austinleivers --force | Out-Null
  }
} finally {
  Pop-Location
}
