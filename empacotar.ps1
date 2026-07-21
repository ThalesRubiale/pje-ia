# Empacota a extensão para a Chrome Web Store.
# Uso: pwsh ./empacotar.ps1  →  gera pje-ia-v<versão>.zip na raiz (ignorado pelo git).
# O ZIP contém APENAS o que a extensão precisa em runtime: manifest.json, src/, icons/.

$ErrorActionPreference = "Stop"
$raiz = $PSScriptRoot

$manifest = Get-Content (Join-Path $raiz "manifest.json") -Raw | ConvertFrom-Json
$versao = $manifest.version
$zip = Join-Path $raiz "pje-ia-v$versao.zip"

# Valida a sintaxe dos scripts antes de empacotar (não há build step)
Get-ChildItem (Join-Path $raiz "src\*.js") | ForEach-Object {
  node --check $_.FullName
  if ($LASTEXITCODE -ne 0) { throw "Erro de sintaxe em $($_.Name) — pacote NÃO gerado." }
}

$staging = Join-Path ([System.IO.Path]::GetTempPath()) "pje-ia-pack-$versao"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging | Out-Null

Copy-Item (Join-Path $raiz "manifest.json") $staging
Copy-Item (Join-Path $raiz "src") (Join-Path $staging "src") -Recurse
Copy-Item (Join-Path $raiz "icons") (Join-Path $staging "icons") -Recurse

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zip
Remove-Item $staging -Recurse -Force

$tam = "{0:N0} KB" -f ((Get-Item $zip).Length / 1KB)
Write-Host "✔ Pacote gerado: $zip ($tam)" -ForegroundColor Green
Write-Host "  Envie este arquivo na aba 'Pacote' do painel do desenvolvedor da Chrome Web Store."
