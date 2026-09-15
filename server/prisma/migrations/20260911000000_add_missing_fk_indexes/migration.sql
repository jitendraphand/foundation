-- Foreign keys Postgres does not auto-index. Most are low-traffic, but two sit
-- on delete paths: deleting a User cascades through QuestionFlag.resolvedById
-- and BackupArchive.createdById, which without indexes are sequential scans.
CREATE INDEX IF NOT EXISTS "Question_curriculumNodeId_idx" ON "Question"("curriculumNodeId");
CREATE INDEX IF NOT EXISTS "GenerationRun_promptTemplateId_idx" ON "GenerationRun"("promptTemplateId");
CREATE INDEX IF NOT EXISTS "Test_releasedById_idx" ON "Test"("releasedById");
CREATE INDEX IF NOT EXISTS "QuestionFlag_attemptId_idx" ON "QuestionFlag"("attemptId");
CREATE INDEX IF NOT EXISTS "QuestionFlag_resolvedById_idx" ON "QuestionFlag"("resolvedById");
CREATE INDEX IF NOT EXISTS "BackupArchive_createdById_idx" ON "BackupArchive"("createdById");
CREATE INDEX IF NOT EXISTS "AuditLog_entityId_idx" ON "AuditLog"("entityId");
