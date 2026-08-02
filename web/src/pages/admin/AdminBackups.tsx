import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { Alert, Badge, Card, EmptyState, Modal, PageLoader, Spinner, formatDate } from '../../components/ui';

interface Backup {
  id: string;
  filename: string;
  byteSize: number;
  sha256: string;
  isEncrypted: boolean;
  includesAssets: boolean;
  manifest: { tableCounts?: Record<string, number>; assetFiles?: number; schemaVersion?: number; appVersion?: string };
  createdAt: string;
  fileExists: boolean;
  createdBy: { username: string } | null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function AdminBackups() {
  const [backups, setBackups] = useState<Backup[]>([]);
  const [retentionDays, setRetentionDays] = useState(7);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showRestore, setShowRestore] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ backups: Backup[]; retentionDays: number }>('/api/admin/backups');
      setBackups(res.backups);
      setRetentionDays(res.retentionDays);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load backups.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.post<{ backup: Backup; downloadUrl: string; message: string }>('/api/admin/backups', { includeAssets: true });
      setNotice(res.message);
      await load();
      // Start the download straight away - the whole point is getting the file
      // off this server and onto Google Drive.
      window.location.href = res.downloadUrl;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The backup failed.');
    } finally {
      setCreating(false);
    }
  };

  const remove = async (backup: Backup) => {
    try {
      await api.delete(`/api/admin/backups/${backup.id}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete that archive.');
    }
  };

  if (loading) return <PageLoader label="Loading backups" />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Backups</h1>
        <div className="flex gap-2">
          <button type="button" className="btn-secondary btn-sm" onClick={() => setShowRestore(true)}>
            How to restore
          </button>
          <button type="button" className="btn-primary btn-sm" onClick={create} disabled={creating}>
            {creating ? <Spinner label="Creating backup" /> : 'Generate backup'}
          </button>
        </div>
      </div>

      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      <Card title="What is in a backup">
        <ul className="text-sm text-ink-muted space-y-1.5 list-disc pl-5">
          <li>Every user, including usernames and password hashes, so people can sign in again after a restore.</li>
          <li>Every test, question, answer key, attempt and mark.</li>
          <li>All uploaded images and diagrams.</li>
          <li>
            Two copies of the data: a native PostgreSQL dump for a fast exact restore, and a plain JSON export that
            stays readable even after a future PostgreSQL upgrade or a schema change.
          </li>
        </ul>
        <p className="mt-3 text-sm text-ink-muted">
          The archive is encrypted with your <code className="font-mono text-xs">BACKUP_PASSPHRASE</code>, so it is safe
          to upload to Google Drive. Keep that passphrase somewhere separate — without it the archive cannot be restored.
        </p>
        <p className="mt-2 text-xs text-ink-faint">
          Archives older than {retentionDays} days are removed from the server automatically. Copies you have already
          downloaded are unaffected.
        </p>
      </Card>

      {backups.length === 0 ? (
        <Card>
          <EmptyState
            title="No backups yet"
            hint="Generate one now, then download it and put it somewhere safe."
            action={<button type="button" className="btn-primary btn-sm" onClick={create} disabled={creating}>Generate backup</button>}
          />
        </Card>
      ) : (
        <Card padded={false}>
          <div className="scroll-x">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Created</th>
                  <th>File</th>
                  <th className="text-right">Size</th>
                  <th>Contents</th>
                  <th>By</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {backups.map((backup) => {
                  const counts = backup.manifest?.tableCounts ?? {};
                  return (
                    <tr key={backup.id}>
                      <td className="text-xs whitespace-nowrap">{formatDate(backup.createdAt, true)}</td>
                      <td className="font-mono text-[11px] text-ink-muted max-w-[240px] truncate">{backup.filename}</td>
                      <td className="text-right tabular-nums">{formatBytes(backup.byteSize)}</td>
                      <td className="text-xs text-ink-muted">
                        {counts.users ?? 0} users · {counts.questions ?? 0} questions · {counts.attempts ?? 0} attempts
                        {backup.includesAssets && ` · ${backup.manifest?.assetFiles ?? 0} images`}
                      </td>
                      <td className="font-mono text-xs">{backup.createdBy?.username ?? '—'}</td>
                      <td className="text-right whitespace-nowrap">
                        {backup.fileExists ? (
                          <a href={`/api/admin/backups/${backup.id}/download`} className="btn-secondary btn-sm">Download</a>
                        ) : (
                          <Badge>pruned</Badge>
                        )}
                        <button type="button" className="btn-ghost btn-sm text-bad" onClick={() => remove(backup)}>Delete</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Modal open={showRestore} onClose={() => setShowRestore(false)} title="Restoring from a backup" wide>
        <div className="space-y-4 text-sm">
          <Alert tone="warn">
            Restoring replaces the live database. It is done over SSH rather than from this screen, deliberately — it is
            far too easy to click by accident and impossible to undo.
          </Alert>

          <ol className="list-decimal pl-5 space-y-2 text-ink-muted">
            <li>Copy the archive to the server:<br /><code className="font-mono text-xs">scp foundation-backup-*.tar.gz.enc ubuntu@YOUR_IP:~/</code></li>
            <li>Connect:<br /><code className="font-mono text-xs">ssh ubuntu@YOUR_IP</code></li>
            <li>Run the restore script:<br /><code className="font-mono text-xs">cd ~/foundation &amp;&amp; ./deploy/restore.sh ~/foundation-backup-TIMESTAMP.tar.gz.enc</code></li>
            <li>The script stops the API, restores the database and images, then brings everything back up.</li>
          </ol>

          <p className="text-ink-muted">
            The <code className="font-mono text-xs">BACKUP_PASSPHRASE</code> in your <code className="font-mono text-xs">.env</code>{' '}
            must match the value in force when the archive was created.
          </p>
        </div>
      </Modal>
    </div>
  );
}
