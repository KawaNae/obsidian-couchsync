# start-broker.ps1
# Loads CouchSync credential from Bitwarden vault and launches inspect-proxy.
# Username / password / URI all come from a single vault item (default name
# "CouchSync", override with $env:COUCHSYNC_VAULT_ITEM).
#
# Credential exists only in this PowerShell process and the broker child
# process. Both die when broker exits (Ctrl-C).
#
# Prereq: bw is installed, `bw login` done once.

# Vault item name (override via env if your item has a different name)
$VaultItem = if ($env:COUCHSYNC_VAULT_ITEM) { $env:COUCHSYNC_VAULT_ITEM } else { 'CouchSync' }

if (-not $env:BW_SESSION) {
    Write-Host "Unlocking Bitwarden vault..."
    $env:BW_SESSION = bw unlock --raw
    if (-not $env:BW_SESSION -or $LASTEXITCODE -ne 0) {
        Write-Error "Bitwarden unlock failed."
        exit 1
    }
}

Write-Host "Fetching '$VaultItem' from vault..."
$itemJson = bw get item $VaultItem
if ($LASTEXITCODE -ne 0 -or -not $itemJson) {
    Write-Error "Could not retrieve '$VaultItem' from vault. Verify the item exists."
    exit 1
}
$item = $itemJson | ConvertFrom-Json

$env:COUCHSYNC_USER     = $item.login.username
$env:COUCHSYNC_PASSWORD = $item.login.password
# URI is taken from the item's first URI entry (unambiguous because we
# fetched the item by name, not by `bw get uri` which matches on URI substring).
if ($item.login.uris -and $item.login.uris.Count -gt 0) {
    $env:COUCHSYNC_URI = $item.login.uris[0].uri
}

if (-not $env:COUCHSYNC_USER -or -not $env:COUCHSYNC_PASSWORD) {
    Write-Error "'$VaultItem' is missing username or password fields."
    exit 1
}
if (-not $env:COUCHSYNC_URI) {
    Write-Error "'$VaultItem' has no URI configured. Add the CouchDB base URL (e.g. https://host:6984) to the item's URI field in Bitwarden."
    exit 1
}

try {
    python "$PSScriptRoot\inspect-proxy.py"
}
finally {
    Remove-Item Env:\COUCHSYNC_URI      -ErrorAction SilentlyContinue
    Remove-Item Env:\COUCHSYNC_USER     -ErrorAction SilentlyContinue
    Remove-Item Env:\COUCHSYNC_PASSWORD -ErrorAction SilentlyContinue
    Write-Host "credentials cleared from this shell."
}
