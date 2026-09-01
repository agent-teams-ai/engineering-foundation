$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

try {
  Add-Type -Path (Join-Path $PSScriptRoot "WindowsManagedProcess.cs")
  $bootstrapRequest = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ([int]$bootstrapRequest.schemaVersion -ne 1) {
    throw "Unsupported Windows managed-process bootstrap schema."
  }
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
    "Windows Job Object runner failed: " + $_.Exception.Message)
  exit 1
}
