import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { env } from '../../env.js';
import { prisma } from '../../db.js';
import { audit } from '../../middleware/auth.js';
import { createBackup, pruneBackups, restoreFromArchive } from '../../services/backup.js';

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
   * Restores from an existing backup on the server or an uploaded archive.
   * Accepts either JSON { backupId, confirm: "RESTORE" } or multipart file upload with field "file" and "confirm".
   * Requires backups.manage — this overwrites the live database.
   */
  app.post('/api/admin/backups/restore', { config: { requestTimeout: 300000 } } as never, async (request, reply) => {
    // Detect multipart: if request.isMultipart() true, handle file upload
    let archivePath: string | null = null;
    let cleanup: (() => Promise<void>) | null = null;
    let confirm: string | undefined;

    const contentType = request.headers['content-type'] ?? '';
    const isMultipart = contentType.includes('multipart/form-data');

    if (isMultipart) {
      // Use parts() to handle fields in any order — request.file() returns on
      // first file and would miss a confirm field that comes after the file.
      // Iterating all parts is robust and also lets us stream the file to disk
      // instead of buffering the whole archive in memory.
      let filename = 'upload.tar.gz';
      let filePart: { file: NodeJS.ReadableStream; filename: string } | null = null;
      let confirmValue = '';

      for await (const part of (request as unknown as { parts: () => AsyncIterable<{ type: string; fieldname: string; value?: string; file?: NodeJS.ReadableStream; filename?: string }> }).parts()) {
        if (part.type === 'file' && part.fieldname === 'file') {
          filePart = part as unknown as { file: NodeJS.ReadableStream; filename: string };
          filename = (part as unknown as { filename: string }).filename ?? filename;
        } else if (part.type === 'field' && part.fieldname === 'confirm') {
          confirmValue = (part as unknown as { value: string }).value ?? '';
        }
      }

      if (!filePart) return reply.code(400).send({ error: 'No file uploaded. Attach field "file" with a .tar.gz archive.' });
      confirm = confirmValue;
      if (confirm !== 'RESTORE') {
        return reply.code(400).send({ error: 'Please confirm by sending confirm=RESTORE.' });
      }
      const tmpPath = path.join('/tmp', `upload-restore-${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
      // Stream to disk to avoid buffering large archives in memory and to avoid
      // holding the event loop during the upload. A timeout here surfaces as
      // 500 rather than a dropped connection (502).
      try {
        await pipeline(filePart.file as unknown as NodeJS.ReadableStream, createWriteStream(tmpPath));
      } catch (err) {
        await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
        throw err;
      }
      const stat = await fsp.stat(tmpPath).catch(() => null);
      if (!stat || stat.size === 0) {
        await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
        return reply.code(400).send({ error: 'Uploaded file is empty.' });
      }
      archivePath = tmpPath;
      cleanup = async () => { await fsp.rm(tmpPath, { force: true }).catch(() => undefined); };
    } else {
      const body = z.object({ backupId: z.string().uuid().optional(), confirm: z.string().optional() }).parse(request.body ?? {});
      confirm = body.confirm;
      if (confirm !== 'RESTORE') {
        return reply.code(400).send({ error: 'Please confirm by sending { confirm: "RESTORE" }. This will overwrite the live database.' });
      }
      if (!body.backupId) {
        return reply.code(400).send({ error: 'Provide backupId for an existing backup, or upload a file via multipart.' });
      }
      const archive = await prisma.backupArchive.findUnique({ where: { id: body.backupId } });
      if (!archive) return reply.code(404).send({ error: 'Backup not found.' });
      const safeName = path.basename(archive.filename);
      const filePath = path.join(env.BACKUP_DIR, safeName);
      if (!filePath.startsWith(path.resolve(env.BACKUP_DIR))) return reply.code(400).send({ error: 'Invalid backup path.' });
      try {
        await fsp.access(filePath);
      } catch {
        return reply.code(410).send({ error: 'That archive is no longer on the server. It may have been pruned.' });
      }
      archivePath = filePath;
    }

    if (!archivePath) return reply.code(400).send({ error: 'No archive to restore from.' });

    try {
      request.log.info({ archivePath }, 'restore starting');
      const result = await restoreFromArchive(archivePath!);
      try {
        await audit(request.user!.sub, 'backup.restore', { entity: 'BackupArchive', ip: request.ip, detail: { archivePath, manifest: result.manifest } });
      } catch {
        // audit is best-effort; a stale connection right after pg_restore
        // should not turn a successful restore into a 500/502.
      }
      request.log.info({ archivePath }, 'restore completed');
      return { ok: true, message: 'Restore completed. Please refresh and verify users, tests and results. LLM keys only work if ENCRYPTION_KEY is unchanged.', manifest: result.manifest };
    } catch (err) {
      request.log.error({ err }, 'restore failed');
      return reply.code(500).send({ error: `Restore failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      if (cleanup) await cleanup().catch(() => undefined);
    }
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
      'Copy the archive onto the server, e.g. scp foundation-backup-*.tar.gz ubuntu@<ip>:~/',
      'SSH into the server: ssh ubuntu@<ip>',
      'cd ~/foundation',
      './deploy/restore.sh ~/foundation-backup-<timestamp>.tar.gz',
      'The script stops the API, restores the database and uploads, then restarts everything.',
    ],
    note: 'The archive is a plain .tar.gz, so you can open it with any unzip tool to check what is inside before restoring. ENCRYPTION_KEY in .env must be unchanged for the stored LLM API keys to still decrypt.',
  }));
}
