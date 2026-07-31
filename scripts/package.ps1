param(
  [string]$OutputDirectory = "release"
)

$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $PSScriptRoot
$output = if ([System.IO.Path]::IsPathRooted($OutputDirectory)) {
  [System.IO.Path]::GetFullPath($OutputDirectory)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $workspace $OutputDirectory))
}
$manifest = Get-Content -Raw (Join-Path $workspace "manifest.json") | ConvertFrom-Json
$archiveName = "bilingual-web-translation-v$($manifest.version).zip"
$archive = Join-Path $output $archiveName
$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("bwt-package-" + [guid]::NewGuid().ToString("N"))
$verification = Join-Path ([System.IO.Path]::GetTempPath()) ("bwt-verify-" + [guid]::NewGuid().ToString("N"))
$newArchive = Join-Path ([System.IO.Path]::GetTempPath()) ("bwt-archive-" + [guid]::NewGuid().ToString("N") + ".zip")
$files = @(
  "manifest.json",
  "background.js", "content.js", "content.css",
  "popup.html", "popup.js", "popup.css",
  "options.html", "options.js", "options.css",
  "README.md",
  "icons\icon-16.png", "icons\icon-32.png", "icons\icon-48.png", "icons\icon-128.png",
  "icons\floating-ball-128.png"
)

foreach ($relative in $files) {
  if (-not (Test-Path -LiteralPath (Join-Path $workspace $relative) -PathType Leaf)) {
    throw "Missing release file: $relative"
  }
}

Push-Location $workspace
try {
  foreach ($script in @("background.js", "content.js", "popup.js", "options.js")) {
    & node --check $script
    if ($LASTEXITCODE -ne 0) { throw "Syntax check failed: $script" }
  }
  & node test_background.js
  if ($LASTEXITCODE -ne 0) { throw "Background tests failed" }
  & .\test_content.ps1
} finally {
  Pop-Location
}

New-Item -ItemType Directory -Path $staging | Out-Null
try {
  foreach ($relative in $files) {
    $destination = Join-Path $staging $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $workspace $relative) -Destination $destination
  }

  Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $newArchive -CompressionLevel Optimal
  New-Item -ItemType Directory -Path $verification | Out-Null
  Expand-Archive -LiteralPath $newArchive -DestinationPath $verification
  foreach ($relative in $files) {
    if (-not (Test-Path -LiteralPath (Join-Path $verification $relative) -PathType Leaf)) {
      throw "Archive missing: $relative"
    }
  }

  New-Item -ItemType Directory -Path $output -Force | Out-Null
  Copy-Item -LiteralPath $newArchive -Destination $archive -Force
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
  Set-Content -LiteralPath "$archive.sha256" -Value "$hash  $archiveName" -Encoding ascii
  [pscustomobject]@{Archive = $archive; Files = $files.Count; Bytes = (Get-Item -LiteralPath $archive).Length; SHA256 = $hash}
} finally {
  if (Test-Path -LiteralPath $newArchive) { [System.IO.File]::Delete($newArchive) }
  if (Test-Path -LiteralPath $staging) { [System.IO.Directory]::Delete($staging, $true) }
  if (Test-Path -LiteralPath $verification) { [System.IO.Directory]::Delete($verification, $true) }
}
