import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../env.js';
import { prisma } from '../../db.js';
import { sha256File } from '../../lib/crypto.js';
import { audit } from '../../middleware/auth.js';

/**
 * Manual image upload - the escape hatch for when the LLM's diagram is wrong,
 * or when it emitted a "FIGURE NEEDED" code block that a human has to render.
 */

const ALLOWED = new Map<string, string>([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/svg+xml', 'svg'],
  ['image/gif', 'gif'],
]);

const MAX_BYTES = 4 * 1024 * 1024;

export default async function adminAssetRoutes(app: FastifyInstance) {
  app.post('/api/admin/assets', async (request, reply) => {
    const file = await request.file({ limits: { fileSize: MAX_BYTES, files: 1 } });
    if (!file) return reply.code(400).send({ error: 'No file was uploaded.' });

    const ext = ALLOWED.get(file.mimetype);
    if (!ext) {
      return reply.code(400).send({ error: `Unsupported file type "${file.mimetype}". Use PNG, JPEG, WebP, GIF or SVG.` });
    }

    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch {
      return reply.code(413).send({ error: 'That file is larger than the 4 MB limit.' });
    }
    if (buffer.byteLength > MAX_BYTES) {
      return reply.code(413).send({ error: 'That file is larger than the 4 MB limit.' });
    }

    // An uploaded SVG is still untrusted markup; store it as a downloadable
    // file only, and serve it with a content type the browser will not script.
    const sha = sha256File(buffer);

    // Content addressing: the same image uploaded twice is stored once.
    const existing = await prisma.asset.findFirst({ where: { sha256: sha } });
    if (existing) return { ok: true, asset: existing, deduplicated: true };

    const storageKey = `${sha.slice(0, 2)}/${sha}.${ext}`;
    const target = path.join(env.UPLOAD_DIR, storageKey);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buffer);

    const fields = file.fields as Record<string, { value?: string } | undefined>;
    const altText = typeof fields?.altText?.value === 'string' ? fields.altText.value.slice(0, 500) : '';
    const questionId = typeof fields?.questionId?.value === 'string' ? fields.questionId.value : undefined;

    const asset = await prisma.asset.create({
      data: {
        kind: 'IMAGE',
        mimeType: file.mimetype,
        byteSize: buffer.byteLength,
        sha256: sha,
        storageKey,
        altText,
        questionId: questionId && z.string().uuid().safeParse(questionId).success ? questionId : null,
      },
    });

    await audit(request.user!.sub, 'asset.upload', { entity: 'Asset', entityId: asset.id, ip: request.ip });

    return reply.code(201).send({ ok: true, asset });
  });

  app.delete('/api/admin/assets/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const asset = await prisma.asset.findUnique({ where: { id } });
    if (!asset) return reply.code(404).send({ error: 'Asset not found.' });

    await fs.rm(path.join(env.UPLOAD_DIR, asset.storageKey), { force: true }).catch(() => undefined);
    await prisma.asset.delete({ where: { id } });

    return { ok: true };
  });
}

/**
 * Public read path for images. Registered outside the admin scope because
 * students must be able to see the figures in their questions.
 */
export async function assetReadRoutes(app: FastifyInstance) {
  app.get('/uploads/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const asset = await prisma.asset.findUnique({ where: { id } });
    if (!asset) return reply.code(404).send({ error: 'Not found.' });

    const filePath = path.join(env.UPLOAD_DIR, asset.storageKey);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(env.UPLOAD_DIR))) {
      return reply.code(400).send({ error: 'Invalid path.' });
    }

    let buffer: Buffer;
    try {
      buffer = await fs.readFile(resolved);
    } catch {
      return reply.code(404).send({ error: 'The image file is missing from the server.' });
    }

    // SVG is served as a download rather than inline: an inline SVG from an
    // upload could carry script and would run on our own origin.
    const inline = asset.mimeType !== 'image/svg+xml';

    reply.header('Content-Type', inline ? asset.mimeType : 'application/octet-stream');
    reply.header('Content-Disposition', inline ? 'inline' : `attachment; filename="${asset.id}"`);
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(buffer);
  });
}
