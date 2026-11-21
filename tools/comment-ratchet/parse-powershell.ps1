$ErrorActionPreference = 'Stop'
$inputJson = [Console]::In.ReadToEnd() | ConvertFrom-Json
$result = New-Object System.Collections.Generic.List[object]
foreach ($entry in $inputJson.files) {
    $tokens = $null
    $errors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($entry.absolutePath, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) {
        throw ('PowerShell parse failed in ' + $entry.path + ': ' + ($errors[0].Message))
    }
    foreach ($token in $tokens) {
        if ($token.Kind -eq [System.Management.Automation.Language.TokenKind]::Comment) {
            $result.Add([pscustomobject]@{
                path = $entry.path
                start = $token.Extent.StartOffset
                end = $token.Extent.EndOffset
            })
        }
    }
}
@($result.ToArray()) | ConvertTo-Json -Depth 5 -Compress
