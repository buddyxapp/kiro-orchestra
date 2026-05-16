$env:GIT_TERMINAL_PROMPT = "0"
$token = "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"
$remote = "https://${token}@github.com/buddyxapp/kiro-orchestra.git"

# Check if git is available via full path
$gitPath = "C:\Program Files\Git\bin\git.exe"
if (-not (Test-Path $gitPath)) {
    # Try scoop or other locations
    $gitPath = (Get-Command git -ErrorAction SilentlyContinue).Source
}
if (-not $gitPath) {
    Write-Error "Git not found"
    exit 1
}

& $gitPath init
& $gitPath add -A
& $gitPath commit -m "Initial commit: Kiro Orchestra - multi-agent orchestration UI"
& $gitPath branch -M main
& $gitPath remote add origin $remote
& $gitPath push -u origin main
