param([string] $EnvFile = ".env.appwrite.local")

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

function Import-LocalEnvironment([string] $Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Environment file not found: $Path" }
  foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim(); if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
    if ($trimmed -notmatch '^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') { throw "Invalid environment entry in $Path." }
    $value = $Matches[2].Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) { $value = $value.Substring(1, $value.Length - 2) }
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($Matches[1]))) { [Environment]::SetEnvironmentVariable($Matches[1], $value, "Process") }
  }
}
function Invoke-Appwrite { param([Parameter(ValueFromRemainingArguments = $true)][string[]] $Arguments); & npx --yes appwrite-cli@6.1.0 @Arguments; if ($LASTEXITCODE -ne 0) { throw "Pinned Appwrite CLI command failed (exit code $LASTEXITCODE)." } }
function Set-Client([hashtable] $Context) { Invoke-Appwrite client --endpoint $Context.Endpoint --project-id $Context.ProjectId --key $Context.ApiKey | Out-Null }
function Require([string[]] $Names) { $missing = @($Names | Where-Object { [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_)) }); if ($missing.Count) { throw "Required preflight values are missing: $($missing -join ', ')" } }

$path = if ([IO.Path]::IsPathRooted($EnvFile)) { $EnvFile } else { Join-Path $root $EnvFile }
Import-LocalEnvironment $path
Require @("APPWRITE_BACKEND_A_ENDPOINT", "APPWRITE_BACKEND_A_PROJECT_ID", "APPWRITE_BACKEND_A_API_KEY", "APPWRITE_BACKEND_B_ENDPOINT", "APPWRITE_BACKEND_B_PROJECT_ID", "APPWRITE_BACKEND_B_API_KEY", "WEBHOOK_DATABASE_ID", "WEBHOOK_DELIVERY_COLLECTION_ID", "APPWRITE_FUNCTION_GITHUB_PR_REVIEWER_ID", "APPWRITE_FUNCTION_GITHUB_PROFILE_INSIGHTS_ID", "APPWRITE_FUNCTION_GITHUB_DASHBOARD_ID", "APPWRITE_FUNCTION_HEALTH_CHECK_ID")
if (-not (Get-Command npx -ErrorAction SilentlyContinue)) { throw "npx is required for pinned Appwrite CLI 6.1.0." }
Invoke-Appwrite --version | Out-Null

$backendA = @{ Endpoint = $env:APPWRITE_BACKEND_A_ENDPOINT; ProjectId = $env:APPWRITE_BACKEND_A_PROJECT_ID; ApiKey = $env:APPWRITE_BACKEND_A_API_KEY }
$backendB = @{ Endpoint = $env:APPWRITE_BACKEND_B_ENDPOINT; ProjectId = $env:APPWRITE_BACKEND_B_PROJECT_ID; ApiKey = $env:APPWRITE_BACKEND_B_API_KEY }
Push-Location $root
try {
  Write-Host "Read-only preflight: checking Website-independent Backend A and Backend B projects."
  Set-Client $backendA
  $databases = @(Invoke-Appwrite --json databases list | ConvertFrom-Json).databases
  if (-not ($databases | Where-Object { $_.'$id' -eq $env:WEBHOOK_DATABASE_ID } | Select-Object -First 1)) { throw "WEBHOOK_DATABASE_ID was not found in the Backend A Appwrite project." }
  $collections = @(Invoke-Appwrite --json databases list-collections --database-id $env:WEBHOOK_DATABASE_ID | ConvertFrom-Json).collections
  if (-not ($collections | Where-Object { $_.'$id' -eq $env:WEBHOOK_DELIVERY_COLLECTION_ID } | Select-Object -First 1)) { throw "WEBHOOK_DELIVERY_COLLECTION_ID was not found in the Backend A database." }
  $aFunctions = @(Invoke-Appwrite --json functions list | ConvertFrom-Json).functions
  foreach ($id in @($env:APPWRITE_FUNCTION_GITHUB_PR_REVIEWER_ID, $env:APPWRITE_FUNCTION_GITHUB_PROFILE_INSIGHTS_ID)) { if (-not ($aFunctions | Where-Object { $_.'$id' -eq $id } | Select-Object -First 1)) { throw "Function ID $id was not found in Backend A." } }
  Set-Client $backendB
  $bFunctions = @(Invoke-Appwrite --json functions list | ConvertFrom-Json).functions
  foreach ($id in @($env:APPWRITE_FUNCTION_GITHUB_DASHBOARD_ID, $env:APPWRITE_FUNCTION_HEALTH_CHECK_ID)) { if (-not ($bFunctions | Where-Object { $_.'$id' -eq $id } | Select-Object -First 1)) { throw "Function ID $id was not found in Backend B." } }
  Write-Host "Appwrite three-project backend preflight passed. No Appwrite resources were created or changed."
} finally { Pop-Location }
