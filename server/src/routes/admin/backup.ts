import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../env.js';
import { prisma } from '../../db.js';
import { audit } from '../../middleware/auth.js';
import { createBackup, pruneBackups } from '../../services/backup.js';

export default async function adminBackupRoutes(app: FastifyInstance) {
  app.get('/api/admin/backups', async () => {
    const backups = await prisma.backupArchive.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { createdBy: { select: { username: true } } },
    });

    // Flag any row whose file is no longer on disk, e.g. after a prune.
    const withPresence = await Promise.all(
      backups.map(async (b) => ({
        ...b,
        fileExists: await fsp
          .access(path.join(env.BACKUP_DIR, b.filename))
          .then(() => true)
          .catch(() => false),
      })),
    );

    return { backups: withPresence, retentionDays: env.BACKUP_RETENTION_DAYS };
  });

  /**
   * Generates a full archive. Can take a while on a large database, so the
   * request is allowed to run long; the UI shows a spinner.
   */
  app.post('/api/admin/backups', { config: { rateLimit: { max: 6, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const body = z.object({ includeAssets: z.boolean().default(true) }).parse(request.body ?? {});

    try {
      const result = await createBackup({ createdById: request.user!.sub, includeAssets: body.includeAssets });

      await audit(request.user!.sub, 'backup.create', {
        entity: 'BackupArchive', entityId: result.id, ip: request.ip,
        detail: { filename: result.filename, byteSize: result.byteSize },
      });

      return {
        ok: true,
        backup: {
          id: result.id,
          filename: result.filename,
          byteSize: result.byteSize,
          sha256: result.sha256,
          manifest: result.manifest,
        },
        downloadUrl: `/api/admin/backups/${result.id}/download`,
        message: 'Backup created. Download it and store it somewhere safe, such as Google Drive.',
      };
    } catch (err) {
      request.log.error({ err }, 'backup failed');
      return reply.code(500).send({
        error: `Backup failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  app.get('/api/admin/backups/:id/download', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const archive = await prisma.backupArchive.findUnique({ where: { id } });
    if (!archive) return reply.code(404).send({ error: 'Backup not found.' });

    // Defend against a crafted filename escaping the backup directory.
    const safeName = path.basename(archive.filename);
    const filePath = path.join(env.BACKUP_DIR, safeName);
    if (!filePath.startsWith(path.resolve(env.BACKUP_DIR))) {
      return reply.code(400).send({ error: 'Invalid backup path.' });
    }
    if (!fs.existsSync(filePath)) {
      return reply.code(410).send({ error: 'That archive is no longer on the server. It may have been pruned after the retention period.' });
    }

    await audit(request.user!.sub, 'backup.download', { entity: 'BackupArchive', entityId: id, ip: request.ip });

    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${safeName}"`);
    reply.header('Content-Length', String(archive.byteSize));
    reply.header('X-Backup-Sha256', archive.sha256);
    return reply.send(fs.createReadStream(filePath));
  });

  app.delete('/api/admin/backups/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const archive = await prisma.backupArchive.findUnique({ where: { id } });
    if (!archive) return reply.code(404).send({ error: 'Backup not found.' });

    await fsp.rm(path.join(env.BACKUP_DIR, path.basename(archive.filename)), { force: true }).catch(() => undefined);
    await prisma.backupArchive.delete({ where: { id } });
    await audit(request.user!.sub, 'backup.delete', { entity: 'BackupArchive', entityId: id, ip: request.ip });

    return { ok: true };
  });

  app.post('/api/admin/backups/prune', async (request) => {
    const removed = await pruneBackups();
    await audit(request.user!.sub, 'backup.prune', { ip: request.ip, detail: { removed } });
    return { ok: true, removed };
  });

  /**
   * Restore is deliberately NOT exposed over HTTP. Overwriting the live
   * database from a web request is too easy to trigger by accident and too
   * damaging to undo. Restoring is a documented SSH procedure
   * (deploy/restore.sh); this endpoint just returns those instructions.
   */
  app.get('/api/admin/backups/restore-instructions', async () => ({
    summary: 'Restoring is done over SSH, not from this screen, because it overwrites the live database.',
    steps: [
      'Copy the .tar.gz.enc archive onto the server, e.g. scp backup.tar.gz.enc ubuntu@<ip>:~/',
      'SSH into the server: ssh ubuntu@<ip>',
      'cd ~/foundation',
      './deploy/restore.sh ~/foundation-backup-<timestamp>.tar.gz.enc',
      'The script stops the API, restores the database and uploads, then restarts everything.',
    ],
    note: 'The BACKUP_PASSPHRASE in .env must be the same value that was set when the archive was created, or it cannot be decrypted.',
  }));
}
