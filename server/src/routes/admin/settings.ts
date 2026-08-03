import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { audit } from '../../middleware/auth.js';
import { encryptSecret, decryptSecret, keyHint } from '../../lib/crypto.js';
import { PROVIDERS, describeKeyProblem, pingProvider } from '../../llm/providers.js';
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_USER_TEMPLATE } from '../../llm/prompts.js';
import { COMMON_TIMEZONES, WINDOW_PRESETS, isValidTimezone, zonedNow, formatMinute } from '../../lib/availability.js';
import { getSchoolTimezone, setSchoolTimezone } from '../../services/settings.js';

export default async function adminSettingsRoutes(app: FastifyInstance) {
  // --- LLM API credentials -------------------------------------------------

  app.get('/api/admin/credentials', async () => {
    const credentials = await prisma.apiCredential.findMany({
      orderBy: { createdAt: 'asc' },
      // encryptedKey is deliberately never selected.
      select: {
        id: true, provider: true, label: true, baseUrl: true, keyHint: true,
        defaultModel: true, isActive: true, createdAt: true, updatedAt: true,
      },
    });
    return { credentials, providers: Object.values(PROVIDERS) };
  });

  app.post('/api/admin/credentials', async (request, reply) => {
    const body = z
      .object({
        provider: z.string().min(1).max(40),
        label: z.string().trim().min(1).max(100),
        apiKey: z.string().trim().min(8).max(500),
        baseUrl: z.string().url().optional(),
        defaultModel: z.string().max(200).optional(),
      })
      .parse(request.body);

    const def = PROVIDERS[body.provider];
    const baseUrl = body.baseUrl ?? def?.defaultBaseUrl;
    if (!baseUrl) {
      return reply.code(400).send({ error: 'A base URL is required for a custom provider.' });
    }

    // Caught here rather than three screens later as a 401 from the provider.
    const keyProblem = describeKeyProblem(body.provider, body.apiKey);
    if (keyProblem.error) return reply.code(400).send({ error: keyProblem.error });

    const credential = await prisma.apiCredential.create({
      data: {
        provider: body.provider,
        label: body.label,
        baseUrl,
        encryptedKey: encryptSecret(body.apiKey),
        keyHint: keyHint(body.apiKey),
        defaultModel: body.defaultModel ?? def?.suggestedModels[0] ?? null,
      },
      select: { id: true, provider: true, label: true, baseUrl: true, keyHint: true, defaultModel: true, isActive: true },
    });

    await audit(request.user!.sub, 'credential.create', {
      entity: 'ApiCredential', entityId: credential.id, ip: request.ip,
      detail: { provider: body.provider, label: body.label }, // never the key
    });

    return reply.code(201).send({ ok: true, credential, warning: keyProblem.warning });
  });

  app.patch('/api/admin/credentials/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        label: z.string().trim().min(1).max(100).optional(),
        apiKey: z.string().trim().min(8).max(500).optional(),
        baseUrl: z.string().url().optional(),
        defaultModel: z.string().max(200).optional(),
        isActive: z.boolean().optional(),
      })
      .parse(request.body);

    const existing = await prisma.apiCredential.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'Credential not found.' });

    const keyProblem = body.apiKey ? describeKeyProblem(existing.provider, body.apiKey) : {};
    if (keyProblem.error) return reply.code(400).send({ error: keyProblem.error });

    const credential = await prisma.apiCredential.update({
      where: { id },
      data: {
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl } : {}),
        ...(body.defaultModel !== undefined ? { defaultModel: body.defaultModel } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        ...(body.apiKey ? { encryptedKey: encryptSecret(body.apiKey), keyHint: keyHint(body.apiKey) } : {}),
      },
      select: { id: true, provider: true, label: true, baseUrl: true, keyHint: true, defaultModel: true, isActive: true },
    });

    await audit(request.user!.sub, 'credential.update', { entity: 'ApiCredential', entityId: id, ip: request.ip });
    return { ok: true, credential, warning: keyProblem.warning };
  });

  app.delete('/api/admin/credentials/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await prisma.apiCredential.delete({ where: { id } });
    await audit(request.user!.sub, 'credential.delete', { entity: 'ApiCredential', entityId: id, ip: request.ip });
    return { ok: true };
  });

  /** "Test connection" - proves the key works before a real generation run. */
  app.post('/api/admin/credentials/:id/test', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ model: z.string().max(200).optional() }).parse(request.body ?? {});

    const credential = await prisma.apiCredential.findUnique({ where: { id } });
    if (!credential) return reply.code(404).send({ error: 'Credential not found.' });

    const model = body.model || credential.defaultModel || PROVIDERS[credential.provider]?.suggestedModels[0];
    if (!model) return reply.code(400).send({ error: 'Choose a model to test with.' });

    let apiKey: string;
    try {
      apiKey = decryptSecret(credential.encryptedKey);
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : 'Could not read the stored key.' });
    }

    // Say what is wrong with the stored key rather than letting the provider
    // answer "missing authentication header", which sounds like our bug.
    const stored = describeKeyProblem(credential.provider, apiKey);
    if (stored.error) {
      return { ok: false, message: `The saved key cannot work. ${stored.error}` };
    }

    const result = await pingProvider(credential.baseUrl, apiKey, model);
    return stored.warning && !result.ok ? { ...result, message: `${result.message} ${stored.warning}` } : result;
  });

  // --- Prompt templates ----------------------------------------------------

  app.get('/api/admin/prompts', async () => {
    const templates = await prisma.promptTemplate.findMany({ orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] });
    return { templates, defaults: { systemPrompt: DEFAULT_SYSTEM_PROMPT, userTemplate: DEFAULT_USER_TEMPLATE } };
  });

  const promptSchema = z.object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(1000).optional().nullable(),
    systemPrompt: z.string().min(20).max(40_000),
    userTemplate: z.string().min(5).max(40_000),
    kind: z.enum(['REGULAR', 'PRACTICE']).default('REGULAR'),
    isDefault: z.boolean().default(false),
    isActive: z.boolean().default(true),
  });

  app.post('/api/admin/prompts', async (request, reply) => {
    const body = promptSchema.parse(request.body);

    const template = await prisma.$transaction(async (tx) => {
      if (body.isDefault) {
        await tx.promptTemplate.updateMany({ where: { kind: body.kind, isDefault: true }, data: { isDefault: false } });
      }
      return tx.promptTemplate.create({ data: { ...body, description: body.description ?? null } });
    });

    await audit(request.user!.sub, 'prompt.create', { entity: 'PromptTemplate', entityId: template.id, ip: request.ip });
    return reply.code(201).send({ ok: true, template });
  });

  app.patch('/api/admin/prompts/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = promptSchema.partial().parse(request.body);

    const existing = await prisma.promptTemplate.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'Prompt template not found.' });

    const template = await prisma.$transaction(async (tx) => {
      if (body.isDefault) {
        await tx.promptTemplate.updateMany({
          where: { kind: body.kind ?? existing.kind, isDefault: true, NOT: { id } },
          data: { isDefault: false },
        });
      }
      return tx.promptTemplate.update({
        where: { id },
        // Editing bumps the version rather than silently rewriting history:
        // past runs keep their own frozen copy of the prompt.
        data: { ...body, version: { increment: 1 } },
      });
    });

    await audit(request.user!.sub, 'prompt.update', { entity: 'PromptTemplate', entityId: id, ip: request.ip });
    return { ok: true, template };
  });

  app.delete('/api/admin/prompts/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await prisma.promptTemplate.update({ where: { id }, data: { isActive: false } });
    await audit(request.user!.sub, 'prompt.delete', { entity: 'PromptTemplate', entityId: id, ip: request.ip });
    return { ok: true };
  });

  // --- Tag vocabulary ------------------------------------------------------

  app.get('/api/admin/tags', async () => {
    const tags = await prisma.tag.findMany({ orderBy: [{ axis: 'asc' }, { sortOrder: 'asc' }] });
    return { tags };
  });

  app.post('/api/admin/tags', async (request, reply) => {
    const body = z
      .object({
        axis: z.enum(['DIFFICULTY', 'COGNITIVE', 'SKILL']),
        code: z.string().trim().regex(/^[a-z][a-z0-9_]*$/, 'Use lowercase letters, digits and underscores only.').max(60),
        label: z.string().trim().min(1).max(120),
        description: z.string().max(1000).optional(),
        weight: z.number().int().min(0).max(100).default(0),
        sortOrder: z.number().int().default(0),
      })
      .parse(request.body);

    const tag = await prisma.tag.create({ data: body });
    await audit(request.user!.sub, 'tag.create', { entity: 'Tag', entityId: tag.id, ip: request.ip });
    return reply.code(201).send({ ok: true, tag });
  });

  app.patch('/api/admin/tags/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        label: z.string().trim().min(1).max(120).optional(),
        description: z.string().max(1000).optional(),
        weight: z.number().int().min(0).max(100).optional(),
        sortOrder: z.number().int().optional(),
        isActive: z.boolean().optional(),
      })
      .parse(request.body);

    // `code` is intentionally not editable: it is stored on every question and
    // inside every historical breakdown. Deactivate and add a new one instead.
    const tag = await prisma.tag.update({ where: { id }, data: body });
    return { ok: true, tag };
  });

  // --- Grades and divisions ------------------------------------------------

  app.get('/api/admin/classes', async () => {
    const classes = await prisma.schoolClass.findMany({ orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }] });
    return {
      grades: classes.filter((c) => c.kind === 'GRADE'),
      divisions: classes.filter((c) => c.kind === 'DIVISION'),
    };
  });

  app.post('/api/admin/classes', async (request, reply) => {
    const body = z
      .object({
        kind: z.enum(['GRADE', 'DIVISION']),
        code: z.string().trim().min(1).max(20),
        label: z.string().trim().min(1).max(60),
        sortOrder: z.number().int().default(0),
      })
      .parse(request.body);

    const row = await prisma.schoolClass.create({ data: body });
    return reply.code(201).send({ ok: true, class: row });
  });

  app.patch('/api/admin/classes/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        label: z.string().trim().min(1).max(60).optional(),
        sortOrder: z.number().int().optional(),
        isActive: z.boolean().optional(),
      })
      .parse(request.body);

    const row = await prisma.schoolClass.update({ where: { id }, data: body });
    return { ok: true, class: row };
  });

  // --- Curriculum tree -----------------------------------------------------

  app.get('/api/admin/curriculum', async () => {
    const nodes = await prisma.curriculumNode.findMany({ orderBy: [{ level: 'asc' }, { sortOrder: 'asc' }] });
    return { nodes };
  });

  app.post('/api/admin/curriculum', async (request, reply) => {
    const body = z
      .object({
        parentId: z.string().uuid().optional().nullable(),
        level: z.enum(['SUBJECT', 'TOPIC', 'SUBTOPIC']),
        code: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]*$/i, 'Use letters, digits, hyphens and underscores.').max(80),
        label: z.string().trim().min(1).max(160),
        grade: z.string().max(20).optional().nullable(),
        sortOrder: z.number().int().default(0),
      })
      .parse(request.body);

    let path = body.code.toLowerCase();
    if (body.parentId) {
      const parent = await prisma.curriculumNode.findUnique({ where: { id: body.parentId } });
      if (!parent) return reply.code(400).send({ error: 'Parent node not found.' });
      path = `${parent.path}/${body.code.toLowerCase()}`;
    }

    const node = await prisma.curriculumNode.create({
      data: { ...body, parentId: body.parentId ?? null, grade: body.grade ?? null, path },
    });
    return reply.code(201).send({ ok: true, node });
  });

  app.delete('/api/admin/curriculum/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await prisma.curriculumNode.update({ where: { id }, data: { isActive: false } });
    return { ok: true };
  });

  // --- School timezone -----------------------------------------------------

  /**
   * Every daily availability window is wall-clock time in this zone. The
   * container runs UTC, so without this an "8am" window would fire at the
   * wrong hour.
   */
  app.get('/api/admin/timezone', async () => {
    const timezone = await getSchoolTimezone();
    const now = zonedNow(timezone);
    return {
      timezone,
      common: COMMON_TIMEZONES,
      windowPresets: WINDOW_PRESETS,
      // Shown back so the admin can confirm at a glance that it is right.
      localTimeNow: formatMinute(now.minuteOfDay),
      serverTimeUtc: new Date().toISOString(),
    };
  });

  app.put('/api/admin/timezone', async (request, reply) => {
    const { timezone } = z.object({ timezone: z.string().min(1).max(64) }).parse(request.body);

    if (!isValidTimezone(timezone)) {
      return reply.code(400).send({
        error: `"${timezone}" is not a recognised timezone. Use an IANA name such as Asia/Kolkata.`,
      });
    }

    await setSchoolTimezone(timezone);
    await audit(request.user!.sub, 'settings.timezone', { ip: request.ip, detail: { timezone } });

    const now = zonedNow(timezone);
    return {
      ok: true,
      timezone,
      localTimeNow: formatMinute(now.minuteOfDay),
      message: `Timezone set to ${timezone}. It is currently ${formatMinute(now.minuteOfDay)} there.`,
    };
  });

  // --- Audit log -----------------------------------------------------------

  app.get('/api/admin/audit', async (request) => {
    const q = z
      .object({
        action: z.string().optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(request.query);

    const where = q.action ? { action: { startsWith: q.action } } : {};

    const [total, entries] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { actor: { select: { username: true } } },
      }),
    ]);

    return { total, page: q.page, pageSize: q.pageSize, entries };
  });
}
