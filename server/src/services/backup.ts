import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../env.js';
import { prisma } from '../db.js';

/**
 * Backup strategy.
 *
 * Each archive contains BOTH:
 *
 *   db.dump    - pg_dump custom format. Exact, fast, restores in one command.
 *                Tied to the PostgreSQL major version it came from.
 *
 *   data.json  - every table as plain JSON. Slower to restore, but readable by
 *                anything and immune to a PostgreSQL upgrade. This is the copy
 *                that makes the data survive a future migration to a different
 *                schema or even a different database engine.
 *
 *   uploads/   - admin-uploaded images and cached rendered diagrams.
 *   manifest.json - counts, checksums, versions, so a restore can be verified.
 *
 * The whole thing is a .tar.gz, then encrypted with AES-256-CBC using
 * BACKUP_PASSPHRASE, so it is safe to put on Google Drive.
 */

export const SCHEMA_VERSION = 1;
export const APP_VERSION = '1.0.0';

function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...opts.env }, cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => reject(new Error(`${cmd} could not be started: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr.slice(0, 2000)}`));
    });
  });
}

/** Every table, as JSON. The engine-independent copy of the data. */
async function exportJson(): Promise<Record<string, unknown>> {
  const [
    users, schoolClasses, curriculumNodes, tags, questions, assets,
    promptTemplates, generationRuns, apiCredentials, tests, testQuestions,
    attempts, answers, settings,
  ] = await Promise.all([
    prisma.user.findMany(),
    prisma.schoolClass.findMany(),
    prisma.curriculumNode.findMany(),
    prisma.tag.findMany(),
    prisma.question.findMany(),
    prisma.asset.findMany(),
    prisma.promptTemplate.findMany(),
    prisma.generationRun.findMany(),
    prisma.apiCredential.findMany(),
    prisma.test.findMany(),
    prisma.testQuestion.findMany(),
    prisma.attempt.findMany(),
    prisma.answer.findMany(),
    prisma.setting.findMany(),
  ]);

  return {
    // Password hashes and encrypted API keys are included on purpose: a
    // restore must reproduce a working system. This is exactly why the
    // archive is encrypted.
    schemaVersion: SCHEMA_VERSION,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    tables: {
      users, schoolClasses, curriculumNodes, tags, questions, assets,
      promptTemplates, generationRuns, apiCredentials, tests, testQuestions,
      attempts, answers, settings,
    },
  };
}

export interface BackupResult {
  id: string;
  filename: string;
  filePath: string;
  byteSize: number;
  sha256: string;
  manifest: Record<string, unknown>;
}

export async function createBackup(opts: { createdById?: string; includeAssets?: boolean } = {}): Promise<BackupResult> {
  const includeAssets = opts.includeAssets ?? true;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const workDir = path.join(env.BACKUP_DIR, `.work-${stamp}`);
  const filename = `foundation-backup-${stamp}.tar.gz.enc`;
  const filePath = path.join(env.BACKUP_DIR, filename);

  await fs.mkdir(workDir, { recursive: true });

  try {
    // 1. Native dump.
    await run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', path.join(workDir, 'db.dump')], {
      env: {
        PGHOST: process.env.PGHOST ?? 'db',
        PGUSER: process.env.PGUSER ?? '',
        PGPASSWORD: process.env.PGPASSWORD ?? '',
        PGDATABASE: process.env.PGDATABASE ?? '',
      },
    });

    // 2. Portable JSON copy.
    const json = await exportJson();
    await fs.writeFile(path.join(workDir, 'data.json'), JSON.stringify(json, null, 1), 'utf8');

    const tables = json.tables as Record<string, unknown[]>;
    const tableCounts = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]));

    // 3. Uploaded images and cached diagrams.
    let assetCount = 0;
    if (includeAssets) {
      const uploadsTarget = path.join(workDir, 'uploads');
      await fs.mkdir(uploadsTarget, { recursive: true });
      try {
        const entries = await fs.readdir(env.UPLOAD_DIR, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          await fs.copyFile(path.join(env.UPLOAD_DIR, entry.name), path.join(uploadsTarget, entry.name));
          assetCount++;
        }
      } catch {
        // No uploads directory yet - nothing to include.
      }
    }

    // 4. Manifest.
    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      appVersion: APP_VERSION,
      createdAtUtc: new Date().toISOString(),
      postgresDump: 'db.dump',
      jsonExport: 'data.json',
      includesAssets: includeAssets,
      assetFiles: assetCount,
      tableCounts,
    };
    await fs.writeFile(path.join(workDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    // 5. Tar, gzip, encrypt. Streaming through openssl keeps memory flat, which
    //    matters on a 12 GB box that is also serving an exam.
    const tarPath = path.join(env.BACKUP_DIR, `.${stamp}.tar.gz`);
    await run('tar', ['-czf', tarPath, '-C', workDir, '.']);

    await run('openssl', [
      'enc', '-aes-256-cbc', '-pbkdf2', '-iter', '100000', '-salt',
      '-in', tarPath, '-out', filePath,
      '-pass', 'env:BACKUP_PASSPHRASE',
    ], { env: { BACKUP_PASSPHRASE: env.BACKUP_PASSPHRASE } });

    await fs.rm(tarPath, { force: true });

    // 6. Checksum and record.
    const stat = await fs.stat(filePath);
    const sha256 = await hashFile(filePath);

    const record = await prisma.backupArchive.create({
      data: {
        filename,
        byteSize: stat.size,
        sha256,
        isEncrypted: true,
        includesAssets: includeAssets,
        manifest: manifest as object,
        createdById: opts.createdById ?? null,
      },
    });

    return { id: record.id, filename, filePath, byteSize: stat.size, sha256, manifest };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** Deletes local archives older than the retention window. */
export async function pruneBackups(): Promise<number> {
  const cutoff = new Date(Date.now() - env.BACKUP_RETENTION_DAYS * 86_400_000);
  const stale = await prisma.backupArchive.findMany({ where: { createdAt: { lt: cutoff } } });

  let removed = 0;
  for (const archive of stale) {
    await fs.rm(path.join(env.BACKUP_DIR, archive.filename), { force: true }).catch(() => undefined);
    await prisma.backupArchive.delete({ where: { id: archive.id } }).catch(() => undefined);
    removed++;
  }
  return removed;
}
