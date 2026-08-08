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

export const SCHEMA_VERSION = 4;
export const APP_VERSION = '1.3.0';

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

/**
 * Finding a pg_dump that can actually dump this server.
 *
 * pg_dump refuses to dump a server newer than itself, and Debian's
 * `postgresql-client` metapackage installs whichever major version that
 * release happened to ship - 15 on bookworm - while the database here is 16.
 * The result is a backup that fails with
 *
 *   pg_dump: error: aborting because of server version mismatch
 *
 * which reads like a broken installation rather than a missing package.
 *
 * So the version is not assumed. The server is asked what it is, and a
 * matching binary is looked for in the places distributions actually put
 * them - Debian and Ubuntu keep every installed major side by side under
 * /usr/lib/postgresql, which is exactly what makes this fixable at runtime.
 * Only if none is found do we fall back to PATH, and then the error says
 * which package to install.
 */
function majorOf(version: string): number | null {
  const m = /(\d+)/.exec(version);
  return m ? Number(m[1]) : null;
}

async function serverMajor(): Promise<number | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ server_version_num: string }>>(
      'SHOW server_version_num',
    );
    const num = Number(rows?.[0]?.server_version_num);
    // 160014 -> 16. Versions before 10 used a different scheme, which no
    // supported deployment runs.
    return Number.isFinite(num) ? Math.floor(num / 10_000) : null;
  } catch {
    return null;
  }
}

/** The major version a binary reports, or null if it cannot be run at all. */
function toolMajor(binary: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', () => resolve(null));
    child.on('close', () => resolve(majorOf(out.replace(/^\D+/, ''))));
  });
}

const toolCache = new Map<string, string>();

async function findPgTool(name: 'pg_dump' | 'pg_restore'): Promise<string> {
  const cached = toolCache.get(name);
  if (cached) return cached;

  const want = await serverMajor();

  // Ordered best-first. An explicit PG_BIN_DIR always wins, for a deployment
  // that keeps its client tools somewhere of its own choosing.
  const candidates: string[] = [];
  if (process.env.PG_BIN_DIR) candidates.push(path.join(process.env.PG_BIN_DIR, name));
  if (want) {
    candidates.push(
      `/usr/lib/postgresql/${want}/bin/${name}`, // Debian, Ubuntu
      `/usr/pgsql-${want}/bin/${name}`, // RHEL, Rocky, Alma
      `/opt/homebrew/opt/postgresql@${want}/bin/${name}`, // macOS, Apple silicon
      `/usr/local/opt/postgresql@${want}/bin/${name}`, // macOS, Intel
    );
  }
  candidates.push(name); // whatever is on PATH

  let best: { binary: string; major: number } | null = null;
  for (const candidate of candidates) {
    const major = await toolMajor(candidate);
    if (major === null) continue;
    // Newer than the server is fine; older is not.
    if (want && major < want) {
      if (!best) best = { binary: candidate, major };
      continue;
    }
    toolCache.set(name, candidate);
    return candidate;
  }

  const found = best ? `Only ${name} ${best.major} is installed` : `No ${name} was found`;
  throw new Error(
    `${found}, but the database is PostgreSQL ${want ?? 'newer'}. ` +
      `${name} cannot read a server newer than itself. Install the matching client - ` +
      `on Debian or Ubuntu "apt install postgresql-client-${want ?? 16}" - ` +
      'or set PG_BIN_DIR to the directory that holds it.',
  );
}

/**
 * Connection settings for pg_dump.
 *
 * DATABASE_URL is the one place the database is configured, so derive the
 * PG* variables from it rather than requiring the same details to be entered
 * twice. Explicit PG* variables still win, which is what a deployment with a
 * separate backup role would set.
 */
function pgEnv(): NodeJS.ProcessEnv {
  let fromUrl: { host?: string; port?: string; user?: string; password?: string; database?: string } = {};
  try {
    const url = new URL(env.DATABASE_URL);
    fromUrl = {
      host: url.hostname || undefined,
      port: url.port || undefined,
      user: decodeURIComponent(url.username) || undefined,
      password: decodeURIComponent(url.password) || undefined,
      database: url.pathname.slice(1) || undefined,
    };
  } catch {
    // A connection string we cannot parse; fall back to whatever is in the
    // environment and let pg_dump report the problem.
  }

  return {
    PGHOST: process.env.PGHOST ?? fromUrl.host ?? 'db',
    PGPORT: process.env.PGPORT ?? fromUrl.port ?? '5432',
    PGUSER: process.env.PGUSER ?? fromUrl.user ?? '',
    PGPASSWORD: process.env.PGPASSWORD ?? fromUrl.password ?? '',
    PGDATABASE: process.env.PGDATABASE ?? fromUrl.database ?? '',
  };
}

/**
 * Rows to hold in memory at once while writing the JSON copy.
 *
 * The tables that grow without limit are attempts and answers - a year of a
 * whole school - and loading all of them at once is the one path in the system
 * whose memory use is unbounded. They are streamed in pages instead.
 */
const EXPORT_PAGE = 2_000;

/** Reads a whole table in pages, so its size does not decide the heap size. */
async function pagedFindMany<T extends { id: string }>(
  findMany: (args: { take: number; skip: number; cursor?: { id: string }; orderBy: { id: 'asc' } }) => Promise<T[]>,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;

  for (;;) {
    const page: T[] = await findMany({
      take: EXPORT_PAGE,
      skip: cursor ? 1 : 0,
      ...(cursor ? { cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
    });
    if (page.length === 0) break;
    all.push(...page);
    if (page.length < EXPORT_PAGE) break;
    cursor = page[page.length - 1].id;
  }

  return all;
}

/** Every table, as JSON. The engine-independent copy of the data. */
async function exportJson(): Promise<Record<string, unknown>> {
  const [
    users, schoolClasses, curriculumNodes, tags, questions, assets,
    promptTemplates, generationRuns, apiCredentials, tests, testQuestions,
    attempts, answers, settings, activities, activityCompletions,
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
    // The two that grow with every paper sat, so they are read in pages.
    pagedFindMany((args) => prisma.attempt.findMany(args)),
    pagedFindMany((args) => prisma.answer.findMany(args)),
    prisma.setting.findMany(),
    prisma.activity.findMany(),
    prisma.activityCompletion.findMany(),
    // Session rows are deliberately not exported. They are live sign-ins, not
    // data: restoring them would resurrect sessions from whenever the backup
    // was taken. pg_dump carries them for an exact restore; the portable copy
    // is about what the school would lose, and a login is not that.
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
      attempts, answers, settings, activities, activityCompletions,
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
    const pgDump = await findPgTool('pg_dump');
    await run(pgDump, ['--format=custom', '--no-owner', '--no-privileges', '--file', path.join(workDir, 'db.dump')], {
      env: pgEnv(),
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
