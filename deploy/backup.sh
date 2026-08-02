#!/usr/bin/env bash
#
# Creates a backup archive from the command line, without going through the
# admin UI. Useful for cron.
#
#   ./deploy/backup.sh
#
# Archives land in the `backups` Docker volume and are listed in the admin UI,
# where they can be downloaded. To copy one straight to your laptop:
#
#   scp ubuntu@YOUR_IP:~/foundation/backups-export/foundation-backup-*.tar.gz .
#
# To run nightly at 02:30, add this to `crontab -e`:
#
#   30 2 * * * cd /home/ubuntu/foundation && ./deploy/backup.sh >> /home/ubuntu/backup.log 2>&1

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

echo "[$(date -Is)] starting backup"

# The API container owns the backup logic, so it stays identical to the button
# in the admin UI - one implementation, not two that can drift apart.
docker compose exec -T api node -e '
  import("./dist/services/backup.js").then(async (m) => {
    const result = await m.createBackup({ includeAssets: true });
    console.log("created", result.filename, result.byteSize, "bytes");
    console.log("sha256", result.sha256);
    const pruned = await m.pruneBackups();
    if (pruned > 0) console.log("pruned", pruned, "old archive(s)");
    process.exit(0);
  }).catch((err) => { console.error(err); process.exit(1); });
'

echo "[$(date -Is)] backup finished"
echo
echo "Copy it off the server with:"
echo "  docker compose cp api:/app/backups ./backups-export"
echo "then upload the archive to Google Drive."
