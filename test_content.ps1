$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $MyInvocation.MyCommand.Path
$chrome = if ($env:CHROME_PATH -and (Test-Path -LiteralPath $env:CHROME_PATH)) {
  $env:CHROME_PATH
} else {
  "C:\Program Files\Google\Chrome\Application\chrome.exe"
}
$profile = Join-Path ([System.IO.Path]::GetTempPath()) ("bwt-content-test-" + [guid]::NewGuid().ToString("N"))

New-Item -ItemType Directory -Path $profile | Out-Null
try {
  foreach ($testFile in @("test_content.html", "test_features.html", "test_notes_page.html", "test_notes.html", "test_batching.html", "test_multi_model.html", "test_popup.html", "test_options.html", "test_scroll_priority.html")) {
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
    ) -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    if (-not $process.WaitForExit(60000)) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      throw "$testFile browser check timed out after 60s"
    }
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
