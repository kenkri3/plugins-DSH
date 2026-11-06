# Lagrer Cloudflare API-token for DSH uten at den havner i samtalen,
# i shell-historikken eller i en git-commit.
#
#   pwsh -File "C:\Users\glosl\OneDrive\AIChat Norge AS\Vikingent\Plugin Mappestruktur\packages\dsh-plugin-cloudflare\lagre-token.ps1"
#
# Tokenet leses uten ekko, trimmes, og skrives til
# %USERPROFILE%\.dsh\tools\cloudflare\api-token — filen MCP-klienten leser ved oppstart.

$ErrorActionPreference = 'Stop'

$mappe = Join-Path $env:USERPROFILE ".dsh\tools\cloudflare"
$fil = Join-Path $mappe "api-token"
New-Item -ItemType Directory -Force -Path $mappe | Out-Null

$secure = Read-Host "Lim inn Cloudflare API-token (vises ikke)" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim()
    if ($token.Length -lt 20) {
        throw "Tokenet ser for kort ut ($($token.Length) tegn). Ingenting ble lagret."
    }
    Set-Content -Path $fil -Value $token -NoNewline -Encoding ascii
    "Lagret $($token.Length) tegn i $fil"
} finally {
    if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
