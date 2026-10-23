param(
  [ValidateSet("all", "github-pr-reviewer", "github-profile-insights", "health-check", "github-dashboard")]
  [string] $Function = "all",
  [string] $EnvFile = ".env.appwrite.local"
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

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
function Set-AppwriteClient([hashtable] $Context) { Invoke-Appwrite client --endpoint $Context.Endpoint --project-id $Context.ProjectId --key $Context.ApiKey | Out-Null }
function Require-Values([string[]] $Names) {
  $missing = @($Names | Where-Object { [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_)) })
  if ($missing.Count -gt 0) { throw "Required deployment values are missing: $($missing -join ', ')" }
}
function Require-OneOf([string[]] $Names) {
  if (-not @($Names | Where-Object { -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_)) }).Count) { throw "Required deployment value is missing (one of: $($Names -join ', '))" }
}

$resolvedEnvFile = if ([IO.Path]::IsPathRooted($EnvFile)) { $EnvFile } else { Join-Path $repoRoot $EnvFile }
$stagingRoot = Join-Path ([IO.Path]::GetTempPath()) ("ai-agentrouter-appwrite-" + [guid]::NewGuid().ToString("N"))

$functions = @{
  "github-pr-reviewer" = @{ Env = "APPWRITE_FUNCTION_GITHUB_PR_REVIEWER_ID"; Project = "backendA"; Entrypoint = "functions/github-pr-review/src/main.js"; Timeout = 120; Execute = "any"; Variables = @("APP_ID", "PRIVATE_KEY", "WEBHOOK_SECRET", "NVIDIA_API_KEY", "OPENROUTER_API_KEY", "GITHUB_TOKEN", "AI_PROVIDER_ORDER", "AI_MODEL_MODE", "AI_NVIDIA_MODELS", "AI_OPENROUTER_MODELS", "AI_ALLOW_PAID_MODELS", "AI_MODEL_CACHE_SECONDS", "AI_PROVIDER_TIMEOUT_MS", "APPWRITE_FUNCTION_API_ENDPOINT", "APPWRITE_FUNCTION_PROJECT_ID", "APPWRITE_FUNCTION_API_KEY", "WEBHOOK_DATABASE_ID", "WEBHOOK_DELIVERY_COLLECTION_ID", "WEBHOOK_CLAIM_LEASE_MS") }
  "github-profile-insights" = @{ Env = "APPWRITE_FUNCTION_GITHUB_PROFILE_INSIGHTS_ID"; Project = "backendA"; Entrypoint = "functions/github-profile-insights/src/main.js"; Timeout = 60; Execute = "users"; Variables = @("NVIDIA_API_KEY", "OPENROUTER_API_KEY", "AI_PROVIDER_ORDER", "AI_MODEL_MODE", "AI_NVIDIA_MODELS", "AI_OPENROUTER_MODELS", "AI_ALLOW_PAID_MODELS", "AI_MODEL_CACHE_SECONDS", "AI_PROVIDER_TIMEOUT_MS", "GITHUB_TOKEN") }
  "github-dashboard" = @{ Env = "APPWRITE_FUNCTION_GITHUB_DASHBOARD_ID"; Project = "backendB"; Entrypoint = "functions/github-dashboard/src/main.js"; Timeout = 300; Execute = "users"; Variables = @("NVIDIA_API_KEY", "OPENROUTER_API_KEY", "AI_PROVIDER_ORDER", "AI_MODEL_MODE", "AI_NVIDIA_MODELS", "AI_OPENROUTER_MODELS", "AI_ALLOW_PAID_MODELS", "AI_MODEL_CACHE_SECONDS", "AI_PROVIDER_TIMEOUT_MS", "GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_ID", "GITHUB_PRIVATE_KEY", "APP_ID", "PRIVATE_KEY", "APPWRITE_DATA_ENDPOINT", "APPWRITE_DATA_PROJECT_ID", "APPWRITE_DATA_API_KEY", "WEBHOOK_DATABASE_ID", "WEBHOOK_DELIVERY_COLLECTION_ID", "DASHBOARD_REVIEW_COLLECTION_ID", "DASHBOARD_FINDING_COLLECTION_ID", "DASHBOARD_ISSUE_COLLECTION_ID", "DASHBOARD_ALLOWED_USER_IDS", "DASHBOARD_USER_REPOSITORIES", "GITHUB_PATCH_ALLOWED_REPOSITORIES") }
  "health-check" = @{ Env = "APPWRITE_FUNCTION_HEALTH_CHECK_ID"; Project = "backendB"; Entrypoint = "functions/health-check/src/main.js"; Timeout = 15; Execute = "any"; Variables = @() }
}
$targets = if ($Function -eq "all") { @("github-pr-reviewer", "github-profile-insights", "github-dashboard", "health-check") } else { @($Function) }

if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npx -ErrorAction SilentlyContinue)) { throw "Node.js and npx are required for the pinned Appwrite CLI." }
Invoke-Appwrite --version | Out-Null
Push-Location $repoRoot
try {
  # Run tests before importing deployment secrets so test processes cannot
  # accidentally discover real provider credentials and make network calls.
  npm run check; npm test; npm run validate:config; npm run check:dashboard
  Import-LocalEnvironment $resolvedEnvFile
  if ($targets -contains "github-dashboard") {
    # Sync both credential spellings to the same value so a previously deployed
    # higher-priority alias cannot silently override a newly supplied key.
    $appId = if ($env:GITHUB_APP_ID) { $env:GITHUB_APP_ID } else { $env:APP_ID }
    $privateKey = if ($env:GITHUB_PRIVATE_KEY) { $env:GITHUB_PRIVATE_KEY } else { $env:PRIVATE_KEY }
    if ($appId) { $env:GITHUB_APP_ID = $appId; $env:APP_ID = $appId }
    if ($privateKey) { $env:GITHUB_PRIVATE_KEY = $privateKey; $env:PRIVATE_KEY = $privateKey }
  }
  if ([string]::IsNullOrWhiteSpace($env:APPWRITE_FUNCTION_API_ENDPOINT)) { $env:APPWRITE_FUNCTION_API_ENDPOINT = $env:APPWRITE_BACKEND_A_ENDPOINT }
  if ([string]::IsNullOrWhiteSpace($env:APPWRITE_FUNCTION_PROJECT_ID)) { $env:APPWRITE_FUNCTION_PROJECT_ID = $env:APPWRITE_BACKEND_A_PROJECT_ID }
  if ([string]::IsNullOrWhiteSpace($env:APPWRITE_FUNCTION_API_KEY)) { $env:APPWRITE_FUNCTION_API_KEY = $env:APPWRITE_BACKEND_A_API_KEY }
  $required = @()
  $targetProjects = @($targets | ForEach-Object { $functions[$_].Project } | Select-Object -Unique)
  if ($targetProjects -contains "backendA") { Require-Values @("APPWRITE_BACKEND_A_ENDPOINT", "APPWRITE_BACKEND_A_PROJECT_ID", "APPWRITE_BACKEND_A_API_KEY") }
  if ($targetProjects -contains "backendB") { Require-Values @("APPWRITE_BACKEND_B_ENDPOINT", "APPWRITE_BACKEND_B_PROJECT_ID", "APPWRITE_BACKEND_B_API_KEY") }
  if ($targets -contains "github-pr-reviewer" -or $targets -contains "github-dashboard") { Require-Values @("WEBHOOK_DATABASE_ID", "WEBHOOK_DELIVERY_COLLECTION_ID", "DASHBOARD_ISSUE_COLLECTION_ID") }
  foreach ($target in $targets) { Require-Values @($functions[$target].Env) }
  if ($targets -contains "github-dashboard") { Require-Values @("APPWRITE_DATA_ENDPOINT", "APPWRITE_DATA_PROJECT_ID", "APPWRITE_DATA_API_KEY", "DASHBOARD_REVIEW_COLLECTION_ID", "DASHBOARD_FINDING_COLLECTION_ID", "DASHBOARD_ISSUE_COLLECTION_ID", "DASHBOARD_ALLOWED_USER_IDS", "GITHUB_PATCH_ALLOWED_REPOSITORIES", "GITHUB_APP_INSTALLATION_ID"); Require-OneOf @("GITHUB_APP_ID", "APP_ID"); Require-OneOf @("GITHUB_PRIVATE_KEY", "PRIVATE_KEY") }
  $contexts = @{
    backendA = @{ Endpoint = $env:APPWRITE_BACKEND_A_ENDPOINT; ProjectId = $env:APPWRITE_BACKEND_A_PROJECT_ID; ApiKey = $env:APPWRITE_BACKEND_A_API_KEY }
    backendB = @{ Endpoint = $env:APPWRITE_BACKEND_B_ENDPOINT; ProjectId = $env:APPWRITE_BACKEND_B_PROJECT_ID; ApiKey = $env:APPWRITE_BACKEND_B_API_KEY }
  }
  if ($targets -contains "github-pr-reviewer" -or $targets -contains "github-dashboard") {
    Set-AppwriteClient $contexts.backendA
    $databases = @(Invoke-Appwrite --json databases list | ConvertFrom-Json).databases
    if (-not ($databases | Where-Object { $_.'$id' -eq $env:WEBHOOK_DATABASE_ID } | Select-Object -First 1)) { throw "WEBHOOK_DATABASE_ID was not found in the Backend A Appwrite project." }
    $collections = @(Invoke-Appwrite --json databases list-collections --database-id $env:WEBHOOK_DATABASE_ID | ConvertFrom-Json).collections
    if (-not ($collections | Where-Object { $_.'$id' -eq $env:WEBHOOK_DELIVERY_COLLECTION_ID } | Select-Object -First 1)) { throw "WEBHOOK_DELIVERY_COLLECTION_ID was not found in the Backend A project/database." }
    if (-not ($collections | Where-Object { $_.'$id' -eq $env:DASHBOARD_ISSUE_COLLECTION_ID } | Select-Object -First 1)) { throw "DASHBOARD_ISSUE_COLLECTION_ID was not found in the Backend A project/database." }
  }

  foreach ($projectName in @("backendA", "backendB")) {
    $projectTargets = @($targets | Where-Object { $functions[$_].Project -eq $projectName }); if (-not $projectTargets.Count) { continue }
    Set-AppwriteClient $contexts[$projectName]
    $listed = @(Invoke-Appwrite --json functions list | ConvertFrom-Json).functions
    foreach ($name in $projectTargets) {
      $id = [Environment]::GetEnvironmentVariable($functions[$name].Env)
      if (-not ($listed | Where-Object { $_.'$id' -eq $id } | Select-Object -First 1)) { throw "Function $name with ID $id was not found in the $projectName Appwrite project." }
    }
  }

  foreach ($name in $targets) {
    $definition = $functions[$name]; Set-AppwriteClient $contexts[$definition.Project]; $id = [Environment]::GetEnvironmentVariable($definition.Env)
    $existing = @(Invoke-Appwrite --json functions list-variables --function-id $id | ConvertFrom-Json).variables
    foreach ($key in $definition.Variables) {
      $value = [Environment]::GetEnvironmentVariable($key); if ([string]::IsNullOrWhiteSpace($value)) { continue }
      Write-Host "Synchronizing $name variable $key..."
      $variable = $existing | Where-Object { $_.key -eq $key } | Select-Object -First 1
      if ($variable) { Invoke-Appwrite functions update-variable --function-id $id --variable-id $variable.'$id' --key $key --value $value | Out-Null }
      else {
        try { Invoke-Appwrite functions create-variable --function-id $id --key $key --value $value | Out-Null }
        catch {
          # Appwrite can briefly return a stale variable list while an earlier
          # create is becoming visible. Re-read once and converge by update
          # when the key now exists; preserve the original error otherwise.
          $refreshed = @(Invoke-Appwrite --json functions list-variables --function-id $id | ConvertFrom-Json).variables
          $alreadyCreated = $refreshed | Where-Object { $_.key -eq $key } | Select-Object -First 1
          if ($alreadyCreated) { Invoke-Appwrite functions update-variable --function-id $id --variable-id $alreadyCreated.'$id' --key $key --value $value | Out-Null }
          else { throw }
        }
      }
    }
    Invoke-Appwrite functions update --function-id $id --name $name --timeout $definition.Timeout --entrypoint $definition.EntryPoint --commands "npm ci" --enabled true --logging true --execute $definition.Execute | Out-Null
    # Stage only runtime files. The repository also contains inbox attachments,
    # diagrams, reports, and tooling artifacts that can exceed Appwrite's archive
    # limit even though they are not needed by the Function.
    if (Test-Path -LiteralPath $stagingRoot) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force }
    New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $stagingRoot "shared/lib") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $stagingRoot ([IO.Path]::GetDirectoryName($definition.EntryPoint))) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $repoRoot "package.json") -Destination $stagingRoot -Force
    Copy-Item -LiteralPath (Join-Path $repoRoot "package-lock.json") -Destination $stagingRoot -Force
    Copy-Item -Path (Join-Path $repoRoot "shared/lib/*") -Destination (Join-Path $stagingRoot "shared/lib") -Force
    Copy-Item -LiteralPath (Join-Path $repoRoot $definition.EntryPoint) -Destination (Join-Path $stagingRoot $definition.EntryPoint) -Force
    Invoke-Appwrite functions create-deployment --function-id $id --code $stagingRoot --entrypoint $definition.EntryPoint --commands "npm ci" --activate true | Out-Null
    Write-Host "Deployed $name to $($definition.Project)."
  }
} finally {
  if (Test-Path -LiteralPath $stagingRoot) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue }
  Pop-Location
}
