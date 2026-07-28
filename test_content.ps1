$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $MyInvocation.MyCommand.Path
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$profile = Join-Path ([System.IO.Path]::GetTempPath()) ("bwt-content-test-" + [guid]::NewGuid().ToString("N"))

New-Item -ItemType Directory -Path $profile | Out-Null
try {
  $page = ([uri](Join-Path $workspace "test_content.html")).AbsoluteUri
  $output = & $chrome "--headless=new" "--disable-gpu" "--no-first-run" "--allow-file-access-from-files" "--user-data-dir=$profile" "--virtual-time-budget=2000" "--dump-dom" $page 2>$null
  if ($LASTEXITCODE -ne 0 -or $output -notmatch 'data-test="passed"') {
    throw "content browser check failed"
  }
  Write-Output "content browser check passed"
} finally {
  if (Test-Path -LiteralPath $profile) {
    [System.IO.Directory]::Delete($profile, $true)
  }
}
