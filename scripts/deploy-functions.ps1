param(
  [ValidateSet("all", "github-pr-review", "github-profile-insights", "health-check")]
  [string] $Function = "all"
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$appwriteCommand = (Get-Command appwrite -ErrorAction Stop).Source

$functions = @{
  "github-pr-review" = @{
    Env = "APPWRITE_FUNCTION_GITHUB_PR_REVIEW_ID"
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
  }
} finally {
  Pop-Location
}
