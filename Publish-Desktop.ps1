param([Parameter(Mandatory = $true)][string]$PayloadDir)
$ErrorActionPreference = 'Stop'
# Publishing to the source tree's parent makes the SDK exclude the project
# files from its default compile globs. Publish outside that tree first.
$publish = Join-Path $env:TEMP ('nexus-desktop-publish-' + [guid]::NewGuid())
try {
    & dotnet publish (Join-Path $PSScriptRoot 'desktop\Nexus.Desktop.csproj') --configuration Release --output $publish
    if ($LASTEXITCODE -ne 0) { throw 'Desktop publish failed.' }
    New-Item -ItemType Directory -Path $PayloadDir -Force | Out-Null
    Copy-Item -Path (Join-Path $publish '*') -Destination $PayloadDir -Recurse -Force
    & dotnet run --project (Join-Path $PSScriptRoot 'tests\DesktopAssemblyCheck\DesktopAssemblyCheck.csproj') --configuration Release -- (Join-Path $PayloadDir 'Nexus.Desktop.dll')
    if ($LASTEXITCODE -ne 0) { throw 'Installer payload desktop assembly validation failed.' }
} finally {
    if (Test-Path -LiteralPath $publish) { Remove-Item -LiteralPath $publish -Recurse -Force }
}
