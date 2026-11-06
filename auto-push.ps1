# auto-push.ps1 - committer og pusher prosjektmappen til GitHub (main).
#
# Kjøres av Windows-oppgaven "AIChat plugin-autopush" hvert kvarter.
#
#  1. henter origin/main
#  2. legger til nye og endrede filer - ALDRI slettinger, så filer som bare
#     finnes i repoet ikke fjernes ved et uhell
#  3. stopper hvis en enkelt fil er over 20 MB
#  4. committer med tidsstempel og pusher til main
#  5. skriver én linje til auto-push.log, og avslutter rolig når det ikke er noe nytt
#
# Slå av:  Disable-ScheduledTask -TaskName 'AIChat plugin-autopush'
# Konflikt: skriptet rebaser mot origin/main. Går det ikke, logges det og
#           ingenting pushes - løs det for hånd og kjør skriptet igjen.
#
# Ren ASCII med vilje: Windows PowerShell 5.1 leser UTF-8 uten BOM som ANSI,
# og da blir norske tegn til soppel som bryter parsingen.

$ProgressPreference = 'SilentlyContinue'
$repo = 'C:\Users\glosl\OneDrive\AIChat Norge AS\Vikingent\Plugin Mappestruktur'
$logg = Join-Path $repo 'auto-push.log'
$maksBytes = 20MB
$env:GIT_TERMINAL_PROMPT = '0'
$ErrorActionPreference = 'Continue'

function Skriv([string]$tekst) {
  $linje = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $tekst
  Add-Content -Path $logg -Value $linje -Encoding UTF8
  Write-Output $linje
}

if (-not (Test-Path (Join-Path $repo '.git'))) {
  Skriv 'FEIL: ingen .git i mappen'
  exit 1
}

Set-Location $repo

# 1. Fersk oversikt, uten aa endre arbeidstreet.
git fetch --quiet origin main | Out-Null

# 2. Nye og endrede filer. --ignore-removal holder slettinger ute.
git add --ignore-removal . | Out-Null

$endret = @(git diff --cached --name-only)
if ($endret.Count -eq 0) { exit 0 }

# 3. Storrelsesvakt.
foreach ($fil in $endret) {
  if (Test-Path $fil) {
    $bytes = (Get-Item $fil).Length
    if ($bytes -gt $maksBytes) {
      $mb = [math]::Round($bytes / 1MB, 1)
      Skriv ("HOPPET OVER: " + $fil + " er " + $mb + " MB - over grensen")
      git reset --quiet
      exit 0
    }
  }
}

# 4. Commit og push.
$antall = $endret.Count
$mld = 'Auto: ' + $antall + ' fil(er) ' + (Get-Date -Format 'yyyy-MM-dd HH:mm')
git commit --quiet -m $mld
$sha = (git rev-parse --short HEAD)

git pull --rebase --quiet origin main | Out-Null
if ($LASTEXITCODE -ne 0) {
  git rebase --abort | Out-Null
  Skriv ('KONFLIKT: rebase mot origin/main feilet ved ' + $sha + ' - ingenting pushet')
  exit 1
}

git push --quiet origin HEAD:main | Out-Null
if ($LASTEXITCODE -ne 0) {
  Skriv ('FEIL: push feilet ved ' + $sha)
  exit 1
}

Skriv ('OK: ' + $sha + ' - ' + $antall + ' fil(er) pushet')
exit 0
