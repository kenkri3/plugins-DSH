# auto-push.ps1 — committer og pusher prosjektmappen til GitHub (main).
#
# Kjøres av en Windows-oppgave hvert kvarter. Skriptet:
#   1. henter origin/main
#   2. legger til nye og endrede filer — ALDRI slettinger, slik at filer som
#      bare finnes i repoet ikke fjernes ved et uhell
#   3. stopper hvis en enkelt fil er over 20 MB (GitHub avviser den uansett)
#   4. committer med tidsstempel og pusher til main
#   5. skriver én linje til auto-push.log, og stopper rolig når det ikke er noe nytt
#
# Slå av: Disable-ScheduledTask -TaskName 'AIChat plugin-autopush'
# Konflikt: skriptet rebaser mot origin/main; går det ikke, logges det og
# ingenting pushes. Da løses det for hånd.

$ErrorActionPreference = 'Stop'
$repo = 'C:\Users\glosl\OneDrive\AIChat Norge AS\Vikingent\Plugin Mappestruktur'
$logg = Join-Path $repo 'auto-push.log'
$maksBytes = 20MB
$env:GIT_TERMINAL_PROMPT = '0'

function Skriv($tekst) {
  $linje = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $tekst
  Add-Content -Path $logg -Value $linje -Encoding UTF8
  Write-Output $linje
}

try {
  if (-not (Test-Path (Join-Path $repo '.git'))) { Skriv 'FEIL: ingen .git i mappen'; exit 1 }
  Set-Location $repo

  # 1. Fersk oversikt, uten å endre arbeidstreet.
  git fetch --quiet origin main 2>&1 | Out-Null

  # 2. Legg til nye og endrede filer; -—ignore-removal holder slettinger ute.
  git add --ignore-removal . 2>&1 | Out-Null

  $endret = (git diff --cached --name-only)
  if (-not $endret) { exit 0 }

  # 3. Størrelsesvakt.
  foreach ($fil in $endret) {
    if (Test-Path $fil) {
      $storrelse = (Get-Item $fil).Length
      if ($storrelse -gt $maksBytes) {
        Skriv ("HOPPET OVER: {0} er {1:N1} MB — over grensen" -f $fil, ($storrelse / 1MB))
        git reset --quiet
        exit 0
      }
    }
  }

  # 4. Commit og push.
  $antall = @($endret).Count
  $mld = 'Auto: {0} fil(er) {1}' -f $antall, (Get-Date -Format 'yyyy-MM-dd HH:mm')
  git commit --quiet -m $mld
  $sha = (git rev-parse --short HEAD)

  git pull --rebase --quiet origin main 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    git rebase --abort 2>&1 | Out-Null
    Skriv ("KONFLIKT: rebase mot origin/main feilet ved {0} — ingenting pushet" -f $sha)
    exit 1
  }

  git push --quiet origin HEAD:main 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Skriv ("FEIL: push feilet ved {0}" -f $sha); exit 1 }

  Skriv ("OK: {0} — {1} fil(er) pushet ({2})" -f $sha, $antall, $mld)
  exit 0
} catch {
  Skriv ("FEIL: " + $_.Exception.Message)
  exit 1
}
