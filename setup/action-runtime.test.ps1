$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'action-runtime.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
# Import the actual policy/collector definitions without running the hosted entry call.
$definitions = $ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] }
Invoke-Expression (($definitions | ForEach-Object { $_.Extent.Text }) -join "`n")
$checks = 0
function Check([bool]$Condition, [string]$Label) {
  if (-not $Condition) { throw "Probe regression: $Label" }
  $script:checks++
}
function Reject([scriptblock]$Action, [string]$Label) {
  $rejected = $false
  try { $null = & $Action } catch { $rejected = $true }
  Check $rejected $Label
}
$asOf = [datetime]::new(2026,10,21,0,0,0,[DateTimeKind]::Utc)
foreach ($version in @('24.22.1','24.22.2','24.23.0')) {
  Assert-ActionNodeVersion 'node24' $version $asOf
  Check $true "fixed $version"
}
foreach ($version in @('24.19.0','24.21.0','24.22.0','20.20.2','22.23.4','26.12.1','28.0.0','v24.22.1','024.22.1','24.022.1','24.22.01','24.22.1-rc.1','24.22.1+custom',"24.22.1`n",'24.22','24.22.1.0','24.9999999999.1','')) {
  Reject { Assert-ActionNodeVersion 'node24' $version $asOf } "negative $version"
}
Reject { Assert-ActionNodeVersion 'node20' '24.22.1' $asOf } 'declared node20 cannot borrow a node24 result'
Assert-ActionNodeVersion 'node24' '24.22.1' ([datetime]::new(2028,4,29,23,59,59,[DateTimeKind]::Utc))
Check $true 'before exclusive EOL cutoff'
Reject { Assert-ActionNodeVersion 'node24' '24.22.1' ([datetime]::new(2028,4,30,0,0,0,[DateTimeKind]::Utc)) } 'at exclusive EOL cutoff'

$real = Get-BundledNodeInfo $env:CE_TEST_NODE
Check ($real.version -ceq $env:CE_TEST_NODE_VERSION) 'real fixed executable version'
Check ([string]::Equals($real.execPath, $env:CE_TEST_NODE, $(if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }))) 'real fixed executable identity'
Reject { Get-BundledNodeInfo (Join-Path $PSScriptRoot 'missing-node-executable') } 'failed process start'
$large = [IO.MemoryStream]::new([byte[]]::new(4097))
try { Reject { Read-BoundedProbeText $large ([datetime]::UtcNow.AddSeconds(1)) } 'bounded output' } finally { $large.Dispose() }
$empty = [IO.MemoryStream]::new()
try { Reject { Read-BoundedProbeText $empty ([datetime]::UtcNow.AddSeconds(-1)) } 'expired read deadline' } finally { $empty.Dispose() }

# Negative probe behavior runs only on the fixed executable in this private child.
function ProbePreload([string]$Code) { $env:NODE_OPTIONS = '--import=data:text/javascript,' + [Uri]::EscapeDataString($Code) }
try {
  ProbePreload "process.stdout.write('not-json');"
  Reject { Get-BundledNodeInfo $env:CE_TEST_NODE } 'malformed identity output'
  ProbePreload "process.stderr.write('synthetic warning');"
  Reject { Get-BundledNodeInfo $env:CE_TEST_NODE } 'stderr refusal'
  ProbePreload "process.execPath='/unrelated/node';"
  Reject { Get-BundledNodeInfo $env:CE_TEST_NODE } 'executable identity mismatch'
  ProbePreload 'process.exit(7);'
  Reject { Get-BundledNodeInfo $env:CE_TEST_NODE } 'nonzero exit'
  $pidFile = [IO.Path]::GetTempFileName()
  $timeoutChild = $null
  try {
    $pidLiteral = ConvertTo-Json -InputObject $pidFile -Compress
    ProbePreload "import {writeFileSync} from 'node:fs';writeFileSync($pidLiteral,String(process.pid));await new Promise(resolve=>setTimeout(resolve,60000));"
    $watch = [Diagnostics.Stopwatch]::StartNew()
    Reject { Get-BundledNodeInfo $env:CE_TEST_NODE } 'bounded process timeout'
    $recordedPid = [IO.File]::ReadAllText($pidFile)
    Check ($recordedPid -match '\A[1-9][0-9]*\z') 'timeout child records its PID'
    try { $timeoutChild = [Diagnostics.Process]::GetProcessById([int]$recordedPid) } catch [ArgumentException] { }
    Check ($watch.Elapsed.TotalSeconds -lt 8) 'timeout returns promptly'
    Check ($null -eq $timeoutChild -or $timeoutChild.WaitForExit(1000)) 'timeout kills its child'
  } finally {
    try {
      if ($timeoutChild -and -not $timeoutChild.HasExited) { $timeoutChild.Kill($true); $timeoutChild.WaitForExit(1000) | Out-Null }
    } finally {
      if ($timeoutChild) { $timeoutChild.Dispose() }
      Remove-Item -LiteralPath $pidFile -Force
    }
  }
} finally { Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue }

$tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$fixtureRoot = [IO.Path]::GetFullPath((Join-Path $tempParent ('ce-action-probe-' + [guid]::NewGuid().ToString('N'))))
$workerLeaf = if ($IsWindows) { 'Runner.Worker.exe' } else { 'Runner.Worker' }
$nodeLeaf = if ($IsWindows) { 'node.exe' } else { 'node' }
$workerPath = Join-Path $fixtureRoot "bin/$workerLeaf"
$nodePath = Join-Path $fixtureRoot "externals/node24/bin/$nodeLeaf"
$workerDll = Join-Path $fixtureRoot 'bin/Runner.Worker.dll'
New-Item -ItemType Directory -Path (Split-Path $workerPath), (Split-Path $nodePath) -Force | Out-Null
[IO.File]::WriteAllText($workerPath, '')
[IO.File]::WriteAllText($workerDll, '')
[IO.File]::WriteAllText($nodePath, '')
$scenario = 'ok'
$probeCalls = 0
$fixtureWorkerId = if ($PID -eq 4242) { 4243 } else { 4242 }
$env:RUNNER_ENVIRONMENT = 'github-hosted'
$env:RUNNER_OS = if ($IsWindows) { 'Windows' } elseif ($IsLinux) { 'Linux' } else { 'macOS' }
$env:RUNNER_ARCH = 'X64'
function Get-Process {
  param([string]$Name, [int]$Id)
  $worker = [pscustomobject]@{ Id = $fixtureWorkerId; Path = $workerPath; Parent = $null }
  if ($scenario -eq 'unreadable') { $worker.Path = $null }
  if ($Name) {
    if ($scenario -eq 'missing') { return @() }
    if ($scenario -eq 'multiple') { return @($worker,$worker) }
    return $worker
  }
  $current = [pscustomobject]@{ Id = $Id; Parent = $(if ($scenario -eq 'unrelated') { $null } else { $worker }) }
  if ($scenario -eq 'cycle') { $current.Parent = $current }
  return $current
}
function Get-BundledNodeInfo([string]$Executable) {
  $script:probeCalls++
  Check ($Executable -ceq $nodePath) 'collector must use bundled path, never PATH'
  if ($scenario -eq 'failed') { throw 'synthetic probe failure' }
  return @{version = $(if ($scenario -eq 'affected') { '24.21.0' } else { '24.22.1' }); execPath = $Executable}
}
try {
  Assert-RunnerActionRuntimes @('node24') | Out-Null
  Check ($probeCalls -eq 1) 'positive collector invoked bundled probe'
  foreach ($scenario in @('missing','multiple','unrelated','cycle','unreadable','failed','affected')) {
    Reject { Assert-RunnerActionRuntimes @('node24') } "collector $scenario"
  }
  $scenario = 'ok'
  Remove-Item -LiteralPath $nodePath
  Reject { Assert-RunnerActionRuntimes @('node24') } 'missing bundled interpreter'
  [IO.File]::WriteAllText($nodePath, '')
  Remove-Item -LiteralPath $workerDll
  Reject { Assert-RunnerActionRuntimes @('node24') } 'unfamiliar worker layout'
  [IO.File]::WriteAllText($workerDll, '')
  foreach ($unsafeName in @('NODE_OPTIONS','FORCE_JAVASCRIPT_ACTIONS_TO_NODE24','ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION','ACTIONS_RUNNER_FORCE_ACTIONS_NODE_VERSION','ACTIONS_RUNNER_HOOK_JOB_STARTED','ACTIONS_RUNNER_HOOK_JOB_COMPLETED')) {
    $before = $probeCalls
    try {
      [Environment]::SetEnvironmentVariable($unsafeName, 'synthetic-unreviewed', 'Process')
      Reject { Assert-RunnerActionRuntimes @('node24') } "unsafe $unsafeName"
      Check ($probeCalls -eq $before) 'unsafe environment refused before probing'
    } finally { [Environment]::SetEnvironmentVariable($unsafeName, $null, 'Process') }
  }
  Reject { Assert-RunnerActionRuntimes @('node20','node24') } 'every used interpreter must be supported'
  Reject { Assert-RunnerActionRuntimes @() } 'empty runtime inventory'
} finally {
  $cleanup = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $fixtureRoot).Path)
  $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
  if (-not $cleanup.StartsWith($tempParent, $comparison)) { throw 'Refuse fixture cleanup outside the verified temporary parent.' }
  Remove-Item -LiteralPath $cleanup -Recurse -Force
}
Write-Output "Action runtime probe: $checks checks passed; only fixed Node $($real.version) executed."
