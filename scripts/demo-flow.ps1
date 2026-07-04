param(
  [string]$BusinessServerUrl = "http://localhost:8081",
  [string]$DemoApiKey = $env:DEMO_API_KEY,
  [decimal]$Amount = 25,
  [switch]$OpenExplorer,
  [switch]$OpenHostedFlow
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host $Message -ForegroundColor Cyan
}

$baseUrl = $BusinessServerUrl.TrimEnd("/")
$demoHeaders = @{}

if ($DemoApiKey) {
  $demoHeaders["X-BwanaPay-Demo-Key"] = $DemoApiKey
}

Write-Step "1. Checking BwanaPay business server health"
$health = Invoke-RestMethod -Method Get -Uri "$baseUrl/health"

if (-not $health.ok) {
  $health | ConvertTo-Json -Depth 10
  throw "Business server health check failed"
}

Write-Host "Health: ok"
Write-Host "Network: $($health.network_passphrase)"

Write-Step "2. Creating a real Anchor Platform SEP-24 deposit transaction"
$requestBody = @{
  kind = "deposit"
  asset_code = "USDC"
  fiat_currency = "ZMW"
  amount = "$Amount"
} | ConvertTo-Json

$created = Invoke-RestMethod `
  -Method Post `
  -Uri "$baseUrl/demo-transaction" `
  -Headers $demoHeaders `
  -ContentType "application/json" `
  -Body $requestBody

if (-not $created.success) {
  $created | ConvertTo-Json -Depth 10
  throw "Deposit creation failed"
}

$transaction = $created.transaction
$proof = $transaction.stellar_proof

Write-Host "Platform transaction ID: $($transaction.id)"
Write-Host "Platform status: $($transaction.status)"
Write-Host "Amount in: $($transaction.amount_in.amount) $($transaction.amount_in.asset)"
Write-Host "Amount out: $($transaction.amount_out.amount) $($transaction.amount_out.asset)"
Write-Host "Hosted SEP-24 URL: $($transaction.interactive_url)"
Write-Host "Stellar proof hash: $($proof.hash)"
Write-Host "Stellar proof ledger: $($proof.ledger)"

Write-Step "3. Reading the same transaction back through the business server"
$status = Invoke-RestMethod `
  -Method Get `
  -Uri "$baseUrl/platform-transaction/$($transaction.id)" `
  -Headers $demoHeaders

Write-Host "Status source: $($status.source)"
Write-Host "Fetched status: $($status.transaction.status)"

if ($OpenHostedFlow -and $transaction.interactive_url) {
  Write-Step "4. Opening Anchor hosted SEP-24 flow"
  Start-Process $transaction.interactive_url
}

if ($OpenExplorer -and $proof.explorer_url) {
  Write-Step "5. Opening Stellar testnet proof"
  Start-Process $proof.explorer_url
}
