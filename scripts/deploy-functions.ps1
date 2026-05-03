param(
  [ValidateSet("all", "github-pr-reviewer", "github-profile-insights", "health-check")]
  [string] $Function = "all"
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$appwriteCommand = (Get-Command appwrite -ErrorAction Stop).Source

# Auto-load Appwrite API settings for REST patch fallback
if (-not $env:APPWRITE_ENDPOINT) {
  $env:APPWRITE_ENDPOINT = "https://cloud.appwrite.io"
}

if (-not $env:APPWRITE_PROJECT_ID) {
  $env:APPWRITE_PROJECT_ID = "69f2da78000231a299a3"
}

if (-not $env:APPWRITE_API_KEY) {
  $env:APPWRITE_API_KEY = "standard_0a1fbf4279cc62011e2d9eed5938e7a4ff3a65b4e22115658713aa75bbe745109d6d09a0d79c7bb5866d23e5acd277b4c31160e2f13e6a84f6a7749d7c4067f84f2692d1207c6ac6d52a2bad546184c5b8c46aa0f9069ec4b55ce63ae2873e50da32c1bc42fb964a4ef2e5d044d3808a33dffcfa76d245f7c30e6abb68495014"
}

$functions = @{
  "github-pr-reviewer" = @{
    Env = "APPWRITE_FUNCTION_GITHUB_PR_REVIEWER_ID"
    Code = "."
    Entrypoint = "functions/github-pr-review/src/main.js"
    Timeout = 60
  }
  "github-profile-insights" = @{
    Env = "APPWRITE_FUNCTION_GITHUB_PROFILE_INSIGHTS_ID"
    Code = "."
    Entrypoint = "functions/github-profile-insights/src/main.js"
    Timeout = 60
  }
  "health-check" = @{
    Env = "APPWRITE_FUNCTION_HEALTH_CHECK_ID"
    Code = "functions/health-check"
    Entrypoint = "src/main.js"
    Timeout = 15
  }
}

function Get-FunctionRecord {
  param(
    [string] $Name,
    [string] $EnvName
  )

  $requestedId = [Environment]::GetEnvironmentVariable($EnvName)
  $functionsList = (& $appwriteCommand functions list --json | ConvertFrom-Json).functions

  if (-not [string]::IsNullOrWhiteSpace($requestedId)) {
    $matchedById = $functionsList | Where-Object { $_.'$id' -eq $requestedId } | Select-Object -First 1
    if ($matchedById) {
      return $matchedById
    }

    throw "Function ID $requestedId for $Name not found in current Appwrite project."
  }

  $matchedByName = $functionsList | Where-Object { $_.name -eq $Name } | Select-Object -First 1
  if ($matchedByName) {
    return $matchedByName
  }

  throw "Function $Name not found. Set `$env:$EnvName or create function first."
}

$targets = if ($Function -eq "all") { $functions.Keys } else { @($Function) }

Push-Location $repoRoot
try {
  foreach ($name in $targets) {
    $config = $functions[$name]
    $functionRecord = Get-FunctionRecord -Name $name -EnvName $config.Env

    Write-Host "Updating $name settings..."
    & $appwriteCommand functions update `
      --function-id $functionRecord.'$id' `
      --name $functionRecord.name `
      --timeout $config.Timeout `
      --entrypoint $config.Entrypoint `
      --commands "npm install" `
      --enabled true `
      --logging true
      

    Write-Host "Deploying $name..."
    & $appwriteCommand functions create-deployment `
      --function-id $functionRecord.'$id' `
      --code $config.Code `
      --entrypoint $config.Entrypoint `
      --commands "npm install" `
      --activate true

        # Force Execute Access = Any after deployment
    Write-Host "Updating execute access to Any for $FunctionId..."

    & $appwriteCommand functions update `
  --function-id $functionRecord.'$id' `
  --name $functionRecord.name `
  --timeout $config.Timeout `
  --entrypoint $config.Entrypoint `
  --commands "npm install" `
  --enabled true `
  --logging true `
  --execute "any" | Out-Null

    Write-Host "Execute access updated to Any."
  }
} finally {
  Pop-Location
}


