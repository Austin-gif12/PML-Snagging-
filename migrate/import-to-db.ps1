# One-off: loads firebase-export.json straight into the PlanetScale database and checks the counts.
# Makes a temporary admin login (expires in 15 minutes), imports with it, then removes it.
# The password is only held in memory; it's never printed or saved.
#   powershell -ExecutionPolicy Bypass -File migrate\import-to-db.ps1
$ErrorActionPreference = 'Stop'
$env:PATH = "$env:USERPROFILE\scoop\apps\nodejs-lts\current;$env:USERPROFILE\scoop\shims;$env:PATH"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$name = "import-" + (Get-Date -Format 'yyyyMMddHHmmss')

Push-Location (Join-Path $here '..')
try {
  if (-not (Test-Path firebase-export.json)) { throw "firebase-export.json not found in $(Get-Location)" }
  if (-not (Test-Path node_modules\postgres)) { npm install --no-audit --no-fund --silent }
  Write-Host "Creating temporary admin login $name (expires in 15 minutes)..." -ForegroundColor Yellow
  $role = pscale role create pml-snagging main $name --inherited-roles postgres --ttl 15m --org austinleivers --format json | ConvertFrom-Json
  try {
    $env:DATABASE_URL = $role.database_url
    node migrate/import-to-db.mjs firebase-export.json
  } finally {
    Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
    # Anything the import created belongs to whoever created it, so hand it to the main postgres role first.
    pscale role reassign pml-snagging main $role.id --successor postgres --org austinleivers --force | Out-Null
    Write-Host "Removing temporary login $name..." -ForegroundColor Yellow
    pscale role delete pml-snagging main $role.id --org austinleivers --force | Out-Null
  }
} finally {
  Pop-Location
}
