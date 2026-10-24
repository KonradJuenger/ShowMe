# Research-only Windows PDH sampling. Never loaded by the product.
param([string]$OutputPath, [string]$ReadyPath, [int]$Samples = 12)
$ErrorActionPreference = 'Continue'
$observations = [System.Collections.Generic.List[object]]::new()
$paths = @('\GPU Engine(*)\Utilization Percentage', '\GPU Process Memory(*)\Dedicated Usage', '\GPU Process Memory(*)\Shared Usage')
try {
  Get-Counter -Counter $paths -SampleInterval 1 -MaxSamples $Samples -ErrorAction SilentlyContinue | ForEach-Object {
    $observations.Add(@{
      epochMs = ([DateTimeOffset]$_.Timestamp).ToUnixTimeMilliseconds()
      counters = @($_.CounterSamples | ForEach-Object { @{ instance = $_.InstanceName; path = $_.Path; value = $_.CookedValue; status = $_.Status } })
    })
    if (-not (Test-Path -LiteralPath $ReadyPath)) { Set-Content -LiteralPath $ReadyPath -Value 'ready' }
  }
  $observations | ConvertTo-Json -Depth 6 -Compress | Set-Content -LiteralPath $OutputPath
} catch {
  @{ error = $_.ToString() } | ConvertTo-Json | Set-Content -LiteralPath $OutputPath
  Set-Content -LiteralPath $ReadyPath -Value 'error'
}
