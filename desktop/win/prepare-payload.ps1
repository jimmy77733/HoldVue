# Bundles app/, services/, assets/, optional node/ into payload.zip for embedding in HoldVue.exe
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = (Resolve-Path (Join-Path $here '..\..')).Path
$staging = Join-Path $here 'payload-staging'
$zip = Join-Path $here 'payload.zip'

if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory -Path $staging | Out-Null

$appDest = Join-Path $staging 'app'
New-Item -ItemType Directory -Path $appDest | Out-Null
foreach ($name in @('index.html', 'config.json', 'symbol-dict.json')) {
    $src = Join-Path $root "app\$name"
    if (Test-Path $src) { Copy-Item $src (Join-Path $appDest $name) }
}

Copy-Item -Recurse (Join-Path $root 'services') (Join-Path $staging 'services')
Copy-Item -Recurse (Join-Path $root 'assets') (Join-Path $staging 'assets')
Copy-Item (Join-Path $root 'package.json') (Join-Path $staging 'package.json')

$bundledNode = Join-Path $here 'node'
if (Test-Path (Join-Path $bundledNode 'node.exe')) {
    Copy-Item -Recurse $bundledNode (Join-Path $staging 'node')
    Write-Host "Included bundled node.exe"
}

if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip -CompressionLevel Optimal
Remove-Item -Recurse -Force $staging
Write-Host "Created $zip"
