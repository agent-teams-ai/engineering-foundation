$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$FailurePhase = "helper-source-read"

function ConvertTo-ExtendedLengthPath([string]$Path) {
  if ($Path.StartsWith('\\?\')) {
    return $Path
  }
  if (-not [System.IO.Path]::IsPathRooted($Path)) {
    throw "Windows managed-process helper path must be absolute."
  }
  if ($Path.StartsWith('\\')) {
    return '\\?\UNC\' + $Path.Substring(2)
  }
  return '\\?\' + $Path
}

try {
  $helperSource = [System.IO.File]::ReadAllText(
    (ConvertTo-ExtendedLengthPath (
      Join-Path $PSScriptRoot "WindowsManagedProcess.cs")))
  $FailurePhase = "helper-compile"
  Add-Type -TypeDefinition $helperSource -Language CSharp
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
