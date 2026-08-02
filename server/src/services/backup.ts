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
 * One plain .tar.gz archive containing:
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
 *
 *   manifest.json - counts, checksums, versions, so a restore can be verified.
 *
 * The archive is NOT encrypted, so it can be opened with any unzip tool. It
 * does contain password hashes and encrypted LLM API keys, so keep it in a
 * private folder rather than a shared or public one.
 */

export const SCHEMA_VERSION = 2;
export const APP_VERSION = '1.1.0';

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
    // restore must reproduce a working system.
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
  const filename = `foundation-backup-${stamp}.tar.gz`;
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

    // 3. Uploaded images and cached diagrams. Copied recursively because
    //    assets are stored in sharded subdirectories by hash prefix.
    let assetCount = 0;
    if (includeAssets) {
      const uploadsTarget = path.join(workDir, 'uploads');
      await fs.mkdir(uploadsTarget, { recursive: true });
      try {
        assetCount = await copyTree(env.UPLOAD_DIR, uploadsTarget);
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
      encrypted: false,
      includesAssets: includeAssets,
      assetFiles: assetCount,
      tableCounts,
    };
    await fs.writeFile(path.join(workDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    // 5. Tar and gzip.
    await run('tar', ['-czf', filePath, '-C', workDir, '.']);

    // 6. Checksum and record.
    const stat = await fs.stat(filePath);
    const sha256 = await hashFile(filePath);

    const record = await prisma.backupArchive.create({
      data: {
        filename,
        byteSize: stat.size,
        sha256,
        isEncrypted: false,
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

/** Recursively copies a directory, returning the number of files copied. */
async function copyTree(from: string, to: string): Promise<number> {
  let count = 0;
  const entries = await fs.readdir(from, { withFileTypes: true });

  for (const entry of entries) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(dst, { recursive: true });
      count += await copyTree(src, dst);
    } else if (entry.isFile()) {
      await fs.copyFile(src, dst);
      count++;
    }
  }
  return count;
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
