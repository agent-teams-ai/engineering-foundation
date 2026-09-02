$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$FailurePhase = "helper-load"

try {
  Add-Type -Path (Join-Path $PSScriptRoot "WindowsManagedProcess.cs")
  $FailurePhase = "bootstrap-request"
  $bootstrapRequest = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ([int]$bootstrapRequest.schemaVersion -ne 1) {
    throw "Unsupported Windows managed-process bootstrap schema."
  }
  $FailurePhase = "managed-run"
  $exitCode = [AgentTeams.Foundation.WindowsManagedProcess]::Run(
    [string]$bootstrapRequest.nodeExecutable,
    [string]$bootstrapRequest.processHostPath,
    [string]$bootstrapRequest.requestPath,
    [string]$bootstrapRequest.hostWorkingDirectory,
    [string[]]$bootstrapRequest.environmentEntries,
    [string]$bootstrapRequest.cancellationPath,
    [string]$bootstrapRequest.confirmationPath,
    [string]$bootstrapRequest.launchPath)
  exit $exitCode
} catch {
  [Console]::Error.WriteLine(
    "Windows Job Object runner failed [phase=" + $FailurePhase + "]: " +
      $_.Exception.Message)
  exit 1
}
