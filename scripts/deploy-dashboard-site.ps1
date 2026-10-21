param(
  [string] $EnvFile = ".env.appwrite.local",
  [string] $StagingDirectory = ""
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

function Import-LocalEnvironment {
  param([string] $Path)
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
$required = @("APPWRITE_SITE_ENDPOINT", "APPWRITE_SITE_PROJECT_ID", "APPWRITE_SITE_API_KEY", "APPWRITE_SITE_ID", "APPWRITE_FUNCTION_GITHUB_DASHBOARD_ID", "APPWRITE_BACKEND_B_ENDPOINT", "APPWRITE_BACKEND_B_PROJECT_ID")
$missing = @($required | Where-Object { [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_)) })
if ($missing.Count -gt 0) { throw "Dashboard Site deployment requires nonblank variables: $($missing -join ', ')" }
if ($env:APPWRITE_SITE_ENDPOINT -notmatch '^https://[^\s]+/v1/?$') { throw "APPWRITE_SITE_ENDPOINT must be an HTTPS Appwrite endpoint ending in /v1." }

$staging = if ($StagingDirectory) { [IO.Path]::GetFullPath($StagingDirectory) } else { Join-Path ([IO.Path]::GetTempPath()) ("ai-agentrouter-dashboard-" + [guid]::NewGuid().ToString("N")) }
New-Item -ItemType Directory -Path $staging -Force | Out-Null
foreach ($asset in @("index.html", "app.js", "appwrite.js", "patch-ui.js", "render-state.js", "styles.css", "config.js")) { Copy-Item -LiteralPath (Join-Path $repoRoot "dashboard\$asset") -Destination $staging -Force }
$runtime = @{ endpoint = $env:APPWRITE_BACKEND_B_ENDPOINT; projectId = $env:APPWRITE_BACKEND_B_PROJECT_ID; dashboardFunctionId = $env:APPWRITE_FUNCTION_GITHUB_DASHBOARD_ID } | ConvertTo-Json -Compress
Set-Content -LiteralPath (Join-Path $staging "config.js") -Value "window.__APPWRITE_CONFIG__ = $runtime;" -Encoding utf8
$bundle = Get-ChildItem -LiteralPath $staging -Recurse -File | Get-Content -Raw
foreach ($secretName in @("APPWRITE_API_KEY", "DASHBOARD_ALLOWED_USER_IDS", "GITHUB_TOKEN", "NVIDIA_API_KEY", "OPENROUTER_API_KEY", "PRIVATE_KEY", "WEBHOOK_SECRET")) { if ($bundle -match [regex]::Escape($secretName)) { throw "Refusing to deploy dashboard bundle containing secret name $secretName." } }
if ($bundle -match 'YOUR_APPWRITE|dashboardFunctionId\s*:\s*[\x27\x22][\x27\x22]') { throw "Generated dashboard runtime config is blank or still contains placeholders." }
Write-Host "Dashboard staging directory: $staging"

$archive = Join-Path ([IO.Path]::GetTempPath()) ("ai-agentrouter-dashboard-" + [guid]::NewGuid().ToString("N") + ".tar.gz")
& tar -czf $archive -C $staging .
if ($LASTEXITCODE -ne 0) { throw "Could not create the Site deployment archive. Staging is available at $staging." }
$headers = @{ "X-Appwrite-Project" = $env:APPWRITE_SITE_PROJECT_ID; "X-Appwrite-Key" = $env:APPWRITE_SITE_API_KEY }
try {
  $form = @{ code = Get-Item -LiteralPath $archive; activate = "true" }
  $deployment = Invoke-RestMethod -Method Post -Uri "$($env:APPWRITE_SITE_ENDPOINT.TrimEnd('/'))/sites/$($env:APPWRITE_SITE_ID)/deployments" -Headers $headers -Form $form -ErrorAction Stop
  Write-Host "Dashboard Site deployment submitted: $($deployment.'$id')."
} catch {
  Write-Host "Dashboard staging directory: $staging"
  $detail = if ($_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
  throw "Appwrite Site deployment failed. The staged files remain available at $staging. $detail"
} finally {
  Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
}
