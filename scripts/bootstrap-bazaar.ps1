[CmdletBinding()]
param(
  [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
$serviceUrl = "https://k-data-x402-production.theblack1022.workers.dev"
$receiver = "0x519c79c7EB7566F7353a324472A5CE4f05330C81"
$agentPath = Join-Path (Split-Path $PSScriptRoot -Parent) ".wrangler\agent.mjs"
$projectRoot = Split-Path $PSScriptRoot -Parent
$checkerPath = Join-Path $PSScriptRoot "check-bazaar.mjs"

$targets = @(
  [pscustomobject]@{ Name = "research latest"; Price = 0.02; Url = "$serviceUrl/api/research/latest?limit=1" },
  [pscustomobject]@{ Name = "research consensus"; Price = 0.12; Url = "$serviceUrl/api/research/consensus/000660?window=90d" },
  [pscustomobject]@{ Name = "kimchi premium stats"; Price = 0.12; Url = "$serviceUrl/api/kimchi-premium/stats?symbol=BTC&window=7d&basis=usdt" },
  [pscustomobject]@{ Name = "kimchi premium history"; Price = 0.08; Url = "$serviceUrl/api/kimchi-premium/history?symbol=BTC&window=24h&points=10" }
)

function Show-BazaarStatus {
  Write-Host ""
  Write-Host "Checking the full CDP Bazaar index..."
  & node $checkerPath
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to query the CDP Bazaar index."
  }
}

if ($CheckOnly) {
  Show-BazaarStatus
  exit 0
}

$totalPrice = ($targets | Measure-Object -Property Price -Sum).Sum
Write-Host "This script makes 4 real x402 purchases totaling `$$($totalPrice.ToString('0.00')) USDC on Base."
Write-Host "Receiver: $receiver"
Write-Host "Use a dedicated buyer wallet. Do not use the receiver wallet or your main wallet."
$confirmation = Read-Host "Type SPEND $($totalPrice.ToString('0.00')) to continue"
if ($confirmation -cne "SPEND $($totalPrice.ToString('0.00'))") {
  throw "Purchase cancelled. The confirmation text did not match."
}

$secureKey = Read-Host "Dedicated buyer wallet private key (input is hidden)" -AsSecureString
$keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)

try {
  $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer).Trim()
  if ($plainKey -match "^0x[0-9a-fA-F]{40}$") {
    throw "That is a public Base wallet address, not a private key. Export the private key from a separate dedicated buyer account."
  }
  if ($plainKey -match "^[0-9a-fA-F]{64}$") {
    $plainKey = "0x$plainKey"
  }
  if ($plainKey -notmatch "^0x[0-9a-fA-F]{64}$") {
    throw "Expected a 32-byte EVM private key: 64 hexadecimal characters, with or without the 0x prefix."
  }

  $env:EVM_PRIVATE_KEY = $plainKey
  $plainKey = $null

  Push-Location $projectRoot
  try {
    & npx.cmd esbuild ./test/agent-client.ts --bundle --format=esm --platform=node --outfile=.wrangler/agent.mjs
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to build the x402 buyer client."
    }

    foreach ($target in $targets) {
      Write-Host ""
      Write-Host "Purchasing $($target.Name) for `$$($target.Price.ToString('0.00'))..."
      & node $agentPath $target.Url
      if ($LASTEXITCODE -ne 0) {
        throw "Purchase failed for $($target.Name). Remaining purchases were not attempted."
      }
    }
  }
  finally {
    Pop-Location
  }
}
finally {
  Remove-Item Env:EVM_PRIVATE_KEY -ErrorAction SilentlyContinue
  if ($keyPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
  }
}

Write-Host ""
Write-Host "All four settlements completed. Bazaar may take time to refresh."
Show-BazaarStatus
