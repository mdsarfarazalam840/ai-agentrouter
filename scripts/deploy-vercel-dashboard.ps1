param(
  [string] $EnvFile = ".env.appwrite.local",
  [string] $ProjectName = "ai-agent-router-dashboard"
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

$resolvedEnvFile = if ([IO.Path]::IsPathRooted($EnvFile)) { $EnvFile } else { Join-Path $repoRoot $EnvFile }
Import-LocalEnvironment $resolvedEnvFile
$required = @("APPWRITE_BACKEND_B_ENDPOINT", "APPWRITE_BACKEND_B_PROJECT_ID", "APPWRITE_FUNCTION_GITHUB_DASHBOARD_ID")
$missing = @($required | Where-Object { [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_)) })
if ($missing.Count) { throw "Vercel dashboard deployment requires: $($missing -join ', ')" }

$staging = Join-Path ([IO.Path]::GetTempPath()) ("ai-agentrouter-vercel-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $staging -Force | Out-Null
foreach ($asset in @("index.html", "app.js", "appwrite.js", "patch-ui.js", "render-state.js", "styles.css")) { Copy-Item -LiteralPath (Join-Path $repoRoot "dashboard\$asset") -Destination $staging -Force }
$runtime = @{ endpoint = $env:APPWRITE_BACKEND_B_ENDPOINT; projectId = $env:APPWRITE_BACKEND_B_PROJECT_ID; dashboardFunctionId = $env:APPWRITE_FUNCTION_GITHUB_DASHBOARD_ID } | ConvertTo-Json -Compress
Set-Content -LiteralPath (Join-Path $staging "config.js") -Value "window.__APPWRITE_CONFIG__ = $runtime;" -Encoding utf8

$bundle = Get-ChildItem -LiteralPath $staging -Recurse -File | Get-Content -Raw
foreach ($secretName in @("APPWRITE_API_KEY", "DASHBOARD_ALLOWED_USER_IDS", "GITHUB_TOKEN", "NVIDIA_API_KEY", "OPENROUTER_API_KEY", "PRIVATE_KEY", "WEBHOOK_SECRET")) { if ($bundle -match [regex]::Escape($secretName)) { throw "Refusing to deploy Vercel bundle containing secret name $secretName." } }
Write-Host "Vercel staging directory: $staging"

& npx --yes vercel@64.5.0 deploy $staging --prod --yes --name $ProjectName
if ($LASTEXITCODE -ne 0) { throw "Vercel deployment failed. Staging is available at $staging." }
