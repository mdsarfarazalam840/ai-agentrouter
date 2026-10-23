param(
  [string] $EnvFile = ".env.appwrite.local",
  [string] $DashboardUserEmail = "kekebija1@gmail.com",
  [string] $DashboardUserName = "PRISM Operator",
  [switch] $SkipDashboardUser
)

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
function Require([string[]] $Names) { $missing = @($Names | Where-Object { [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_)) }); if ($missing.Count) { throw "Required dashboard setup values are missing: $($missing -join ', ')" } }
function Set-Client([string] $Endpoint, [string] $ProjectId, [string] $ApiKey) { Invoke-Appwrite client --endpoint $Endpoint --project-id $ProjectId --key $ApiKey | Out-Null }
function Save-EnvValue([string] $Path, [string] $Name, [string] $Value) {
  $lines = @(Get-Content -LiteralPath $Path); $updated = $false
  $output = foreach ($line in $lines) { if ($line -match "^$Name\s*=") { $updated = $true; "$Name=$Value" } else { $line } }
  if (-not $updated) { $output += "$Name=$Value" }
  Set-Content -LiteralPath $Path -Value $output -Encoding utf8
}
function Get-AppwriteHeaders([string] $ProjectId, [string] $ApiKey) { return @{ "X-Appwrite-Project" = $ProjectId; "X-Appwrite-Key" = $ApiKey; "Content-Type" = "application/json" } }
function Invoke-AppwriteRest([string] $Method, [string] $Uri, [hashtable] $Headers, [object] $Body = $null) {
  $params = @{ Method = $Method; Uri = $Uri; Headers = $Headers; ErrorAction = "Stop" }
  if ($null -ne $Body) { $params.ContentType = "application/json"; $params.Body = ($Body | ConvertTo-Json -Depth 10 -Compress) }
  return Invoke-RestMethod @params
}

$envPath = if ([IO.Path]::IsPathRooted($EnvFile)) { $EnvFile } else { Join-Path $root $EnvFile }
Import-LocalEnvironment $envPath
Require @("APPWRITE_BACKEND_B_ENDPOINT", "APPWRITE_BACKEND_B_PROJECT_ID", "APPWRITE_BACKEND_B_API_KEY")
if (-not (Get-Command npx -ErrorAction SilentlyContinue)) { throw "npx is required for pinned Appwrite CLI 6.1.0." }
Invoke-Appwrite --version | Out-Null

Set-Client $env:APPWRITE_BACKEND_B_ENDPOINT $env:APPWRITE_BACKEND_B_PROJECT_ID $env:APPWRITE_BACKEND_B_API_KEY
$functions = @(Invoke-Appwrite --json functions list | ConvertFrom-Json).functions
$functionId = $env:APPWRITE_FUNCTION_GITHUB_DASHBOARD_ID
$function = if ($functionId) { $functions | Where-Object { $_.'$id' -eq $functionId } | Select-Object -First 1 } else { $functions | Where-Object { $_.name -eq "github-dashboard" } | Select-Object -First 1 }

if ($function) {
  if ($function.name -ne "github-dashboard" -or (@($function.execute) -join ",") -ne "users" -or $function.entrypoint -ne "functions/github-dashboard/src/main.js") { throw "Existing Function does not match github-dashboard/users/functions/github-dashboard/src/main.js; refusing to modify it." }
  $functionId = $function.'$id'
  Write-Host "Verified existing github-dashboard Function $functionId in Backend B."
} else {
  $function = Invoke-Appwrite --json functions create --function-id "github-dashboard" --name "github-dashboard" --runtime "node-22" --execute users --timeout 300 --entrypoint "functions/github-dashboard/src/main.js" --commands "npm ci" --enabled true --logging true | ConvertFrom-Json
  $functionId = $function.'$id'
  if ([string]::IsNullOrWhiteSpace($functionId)) { throw "Appwrite did not return the created github-dashboard Function ID." }
  Write-Host "Created github-dashboard Function $functionId in Backend B."
}

$envFileLines = Get-Content -LiteralPath $envPath
$updated = $false
$output = foreach ($line in $envFileLines) {
  if ($line -match '^APPWRITE_FUNCTION_GITHUB_DASHBOARD_ID\s*=') { $updated = $true; "APPWRITE_FUNCTION_GITHUB_DASHBOARD_ID=$functionId" } else { $line }
}
if (-not $updated) { $output += "APPWRITE_FUNCTION_GITHUB_DASHBOARD_ID=$functionId" }
Set-Content -LiteralPath $envPath -Value $output -Encoding utf8
Write-Host "Saved the non-secret dashboard Function ID to $EnvFile."

# Backend A resources: create or reuse stable IDs so the dashboard and webhook
# handlers can be deployed without manual database/collection setup.
Set-Client $env:APPWRITE_BACKEND_A_ENDPOINT $env:APPWRITE_BACKEND_A_PROJECT_ID $env:APPWRITE_BACKEND_A_API_KEY
$databaseId = if ($env:WEBHOOK_DATABASE_ID) { $env:WEBHOOK_DATABASE_ID } else { "ai-agent-router-db" }
$databases = @(Invoke-Appwrite --json databases list | ConvertFrom-Json).databases
$database = $databases | Where-Object { $_.'$id' -eq $databaseId } | Select-Object -First 1
if (-not $database) {
  $database = Invoke-Appwrite --json databases create --database-id $databaseId --name "AI Agent Router" --enabled true | ConvertFrom-Json
  Write-Host "Created Backend A database $databaseId."
}
Save-EnvValue $envPath "WEBHOOK_DATABASE_ID" $databaseId
Save-EnvValue $envPath "APPWRITE_DATA_PROJECT_ID" $env:APPWRITE_BACKEND_A_PROJECT_ID
if ([string]::IsNullOrWhiteSpace($env:APPWRITE_DATA_API_KEY)) {
  Save-EnvValue $envPath "APPWRITE_DATA_API_KEY" $env:APPWRITE_BACKEND_A_API_KEY
  Write-Warning "APPWRITE_DATA_API_KEY was blank, so the Backend A deployment key was assigned as the dashboard data key. Replace it later with a least-privilege Backend A data key if desired."
}

$collectionDefinitions = @(
  @{ Env = "WEBHOOK_DELIVERY_COLLECTION_ID"; Id = "webhook-deliveries"; Name = "Webhook deliveries"; Attributes = @(@("string", "deliveryKey", 128), @("string", "state", 32), @("string", "ownerToken", 128), @("string", "leaseExpiresAt", 64)) }
  @{ Env = "DASHBOARD_REVIEW_COLLECTION_ID"; Id = "dashboard-reviews"; Name = "Dashboard reviews"; Attributes = @(@("string", "reviewId", 128), @("string", "repository", 256), @("string", "fullName", 256), @("integer", "prNumber", 0), @("string", "prTitle", 1000), @("string", "headSha", 128), @("string", "baseSha", 128), @("string", "commitUrl", 2000), @("string", "summary", 20000), @("integer", "score", 0), @("string", "verdict", 64), @("string", "provider", 64), @("string", "model", 256), @("string", "deliveryId", 256), @("string", "status", 64), @("string", "createdAt", 64), @("string", "findings", 20000)) }
  @{ Env = "DASHBOARD_FINDING_COLLECTION_ID"; Id = "dashboard-findings"; Name = "Dashboard findings"; Attributes = @(@("string", "reviewId", 128), @("string", "repository", 256), @("string", "fullName", 256), @("integer", "prNumber", 0), @("string", "prTitle", 1000), @("string", "headSha", 128), @("string", "baseSha", 128), @("string", "commitUrl", 2000), @("string", "summary", 20000), @("integer", "score", 0), @("string", "verdict", 64), @("string", "provider", 64), @("string", "model", 256), @("string", "deliveryId", 256), @("string", "status", 64), @("string", "createdAt", 64), @("string", "findings", 20000)) }
  @{ Env = "DASHBOARD_ISSUE_COLLECTION_ID"; Id = "dashboard-issues"; Name = "Dashboard issues"; Attributes = @(@("string", "repository", 256), @("string", "fullName", 256), @("integer", "issueNumber", 0), @("string", "issueTitle", 1000), @("string", "summary", 20000), @("string", "response", 20000), @("string", "provider", 64), @("string", "model", 256), @("string", "deliveryId", 256), @("string", "status", 64), @("string", "createdAt", 64), @("string", "command", 128)) }
)
$collections = @(Invoke-Appwrite --json databases list-collections --database-id $databaseId | ConvertFrom-Json).collections
foreach ($definition in $collectionDefinitions) {
  $collectionId = [Environment]::GetEnvironmentVariable($definition.Env); if (-not $collectionId) { $collectionId = $definition.Id }
  $collection = $collections | Where-Object { $_.'$id' -eq $collectionId } | Select-Object -First 1
  if (-not $collection) { $collection = Invoke-Appwrite --json databases create-collection --database-id $databaseId --collection-id $collectionId --name $definition.Name --enabled true | ConvertFrom-Json; Write-Host "Created Backend A collection $collectionId." }
  Save-EnvValue $envPath $definition.Env $collectionId
  Write-Host "Ensuring attributes for $collectionId..."
  $backendAHeaders = Get-AppwriteHeaders $env:APPWRITE_BACKEND_A_PROJECT_ID $env:APPWRITE_BACKEND_A_API_KEY
  $attributePayload = Invoke-AppwriteRest "Get" "$($env:APPWRITE_BACKEND_A_ENDPOINT.TrimEnd('/'))/databases/$databaseId/collections/$collectionId/attributes" $backendAHeaders
  $attributes = @($attributePayload.attributes)
  foreach ($attribute in $definition.Attributes) {
    $kind = $attribute[0]; $key = $attribute[1]; $size = [int]$attribute[2]
    if ($attributes | Where-Object { $_.key -eq $key } | Select-Object -First 1) { continue }
    try {
      Write-Host "  Creating $kind attribute $key"
      if ($kind -eq "integer") { $attributeBody = @{ key = $key; required = $false } ; Invoke-AppwriteRest "Post" "$($env:APPWRITE_BACKEND_A_ENDPOINT.TrimEnd('/'))/databases/$databaseId/collections/$collectionId/attributes/integer" $backendAHeaders $attributeBody | Out-Null }
      else { $attributeBody = @{ key = $key; size = $size; required = $false }; Invoke-AppwriteRest "Post" "$($env:APPWRITE_BACKEND_A_ENDPOINT.TrimEnd('/'))/databases/$databaseId/collections/$collectionId/attributes/string" $backendAHeaders $attributeBody | Out-Null }
    } catch { Write-Warning "Attribute $key was not created in this pass; rerun setup after Appwrite finishes processing pending attributes." }
  }
  if ($definition.Env -eq "DASHBOARD_ISSUE_COLLECTION_ID") {
    # Wait for asynchronous attribute creation before creating indexes. A timed
    # out or failed attribute/index must block setup rather than deploy broken reads.
    $attributeKeys = @($definition.Attributes | ForEach-Object { $_[1] })
    $attributesReady = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
      $current = @((Invoke-AppwriteRest "Get" "$($env:APPWRITE_BACKEND_A_ENDPOINT.TrimEnd('/'))/databases/$databaseId/collections/$collectionId/attributes" $backendAHeaders).attributes)
      $pending = @($attributeKeys | Where-Object { $key = $_; -not ($current | Where-Object { $_.key -eq $key -and $_.status -eq "available" } | Select-Object -First 1) })
      if (-not $pending.Count) { $attributesReady = $true; break }
      if (@($current | Where-Object { $_.status -eq "failed" }).Count) { throw "Issue collection attribute creation failed." }
      Start-Sleep -Seconds 2
    }
    if (-not $attributesReady) { throw "Issue collection attributes did not become available within 120 seconds." }

    $indexes = @(
      @{ Key = "issue-fullname-command-created"; Attributes = @("fullName", "issueNumber", "command", '$createdAt'); Orders = @("ASC", "ASC", "ASC", "DESC") }
      @{ Key = "issue-repository-command-created"; Attributes = @("repository", "issueNumber", "command", '$createdAt'); Orders = @("ASC", "ASC", "ASC", "DESC") }
      @{ Key = "issue-command-created"; Attributes = @("command", '$createdAt'); Orders = @("ASC", "DESC") }
    )
    foreach ($index in $indexes) {
      $listed = @(Invoke-Appwrite --json databases list-indexes --database-id $databaseId --collection-id $collectionId | ConvertFrom-Json).indexes
      $existing = $listed | Where-Object { $_.key -eq $index.Key } | Select-Object -First 1
      if ($existing) {
        if ($existing.type -ne "key" -or (@($existing.attributes) -join ",") -ne ($index.Attributes -join ",") -or (@($existing.orders) -join ",").ToUpperInvariant() -ne ($index.Orders -join ",")) { throw "Index $($index.Key) exists with a different definition." }
      } else {
        $arguments = @("--json", "databases", "create-index", "--database-id", $databaseId, "--collection-id", $collectionId, "--key", $index.Key, "--type", "key", "--attributes") + $index.Attributes + @("--orders") + $index.Orders
        Invoke-Appwrite @arguments | Out-Null
      }
      $ready = $false
      for ($attempt = 0; $attempt -lt 60; $attempt++) {
        $listed = @(Invoke-Appwrite --json databases list-indexes --database-id $databaseId --collection-id $collectionId | ConvertFrom-Json).indexes
        $existing = $listed | Where-Object { $_.key -eq $index.Key } | Select-Object -First 1
        if ($existing.status -eq "available") { $ready = $true; break }
        if ($existing.status -eq "failed") { throw "Index $($index.Key) failed: $($existing.error)" }
        Start-Sleep -Seconds 2
      }
      if (-not $ready) { throw "Index $($index.Key) did not become available within 120 seconds." }
    }
  }
}

if (-not $SkipDashboardUser) {
  # Backend B user: find by email first; only prompt for a password if creation
  # is needed. The password remains in memory and is never saved to the repo.
  Set-Client $env:APPWRITE_BACKEND_B_ENDPOINT $env:APPWRITE_BACKEND_B_PROJECT_ID $env:APPWRITE_BACKEND_B_API_KEY
  $users = @(Invoke-Appwrite --json users list --search $DashboardUserEmail | ConvertFrom-Json).users
  $user = $users | Where-Object { $_.email -eq $DashboardUserEmail } | Select-Object -First 1
  if (-not $user) {
    $securePassword = Read-Host "Enter a password (minimum 8 characters) for $DashboardUserEmail" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    try { $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    if ($plainPassword.Length -lt 8) { throw "Dashboard user password must be at least 8 characters." }
    $body = @{ userId = ([guid]::NewGuid().ToString("N")); email = $DashboardUserEmail; password = $plainPassword; name = $DashboardUserName }
    $user = Invoke-AppwriteRest "Post" "$($env:APPWRITE_BACKEND_B_ENDPOINT.TrimEnd('/'))/users" (Get-AppwriteHeaders $env:APPWRITE_BACKEND_B_PROJECT_ID $env:APPWRITE_BACKEND_B_API_KEY) $body
    Write-Host "Created Backend B dashboard user $DashboardUserEmail."
  }
  $allowedUsers = @([Environment]::GetEnvironmentVariable("DASHBOARD_ALLOWED_USER_IDS") -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  if ($allowedUsers -notcontains $user.'$id') { $allowedUsers += $user.'$id' }
  Save-EnvValue $envPath "DASHBOARD_ALLOWED_USER_IDS" ($allowedUsers -join ",")
  Write-Host "Saved the dashboard user allowlist to $EnvFile."
} else { Write-Host "Skipped dashboard user creation by request." }

# Website project: create an empty static Site when no Site ID exists. The
# actual local asset deployment is performed by deploy-dashboard-site.ps1.
Require @("APPWRITE_SITE_ENDPOINT", "APPWRITE_SITE_PROJECT_ID", "APPWRITE_SITE_API_KEY")
$siteIdWasProvided = -not [string]::IsNullOrWhiteSpace($env:APPWRITE_SITE_ID)
$siteId = $env:APPWRITE_SITE_ID; if (-not $siteId) { $siteId = "ai-agent-site" }
$siteUri = "$($env:APPWRITE_SITE_ENDPOINT.TrimEnd('/'))/sites/$siteId"
$siteHeaders = Get-AppwriteHeaders $env:APPWRITE_SITE_PROJECT_ID $env:APPWRITE_SITE_API_KEY
$site = $null
if ($siteIdWasProvided) {
  try { $site = Invoke-AppwriteRest "Get" $siteUri $siteHeaders } catch { if ($_.Exception.Response.StatusCode.value__ -ne 404) { throw } }
}
if (-not $site) {
  $siteBody = @{ siteId = $siteId; name = "AI Agent Router Dashboard"; framework = "other"; enabled = $true; logging = $true; timeout = 15; installCommand = ""; buildCommand = ""; startCommand = ""; outputDirectory = "."; buildRuntime = "node-22"; adapter = "static"; fallbackFile = "index.html"; providerBranches = @(); providerPaths = @(); deploymentRetention = 0; scopes = @() }
  $site = Invoke-AppwriteRest "Post" "$($env:APPWRITE_SITE_ENDPOINT.TrimEnd('/'))/sites" $siteHeaders $siteBody
  Write-Host "Created Website Site $siteId."
}
Save-EnvValue $envPath "APPWRITE_SITE_ID" $siteId
Write-Host "Saved the Website Site ID to $EnvFile."
