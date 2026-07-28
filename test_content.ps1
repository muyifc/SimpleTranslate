$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $MyInvocation.MyCommand.Path
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$profile = Join-Path ([System.IO.Path]::GetTempPath()) ("bwt-content-test-" + [guid]::NewGuid().ToString("N"))

New-Item -ItemType Directory -Path $profile | Out-Null
try {
  foreach ($testFile in @("test_content.html", "test_features.html")) {
    $page = ([uri](Join-Path $workspace $testFile)).AbsoluteUri
    $stdout = Join-Path $profile "$testFile.stdout.txt"
    $stderr = Join-Path $profile "$testFile.stderr.txt"
    $process = Start-Process -FilePath $chrome -ArgumentList @(
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--allow-file-access-from-files",
      "--user-data-dir=$profile",
      "--virtual-time-budget=5000",
      "--dump-dom",
      $page
    ) -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $html = Get-Content -Raw $stdout
    if ($process.ExitCode -ne 0 -or $html -notmatch 'data-test="passed"') {
      $title = [regex]::Match($html, "<title>.*?</title>").Value
      throw "$testFile browser check failed (Chrome exit $($process.ExitCode), $title, $($html.Length) bytes)"
    }
  }
  Write-Output "content browser check passed"
} finally {
  if (Test-Path -LiteralPath $profile) {
    [System.IO.Directory]::Delete($profile, $true)
  }
}
