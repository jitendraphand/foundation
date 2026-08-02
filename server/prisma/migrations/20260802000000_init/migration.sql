-- Sequences backing the stable, human-readable identifiers.
--
--   User.publicId -> USR-00001, USR-00002, ...
--   Test.publicId -> TST-0001,  TST-0002,  ...
--
-- These are assigned by the database at INSERT time and are never updated, so
-- a student keeps the same identity through any number of spelling
-- corrections, username changes or class moves.
CREATE SEQUENCE IF NOT EXISTS "user_public_id_seq" START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS "test_public_id_seq" START WITH 1 INCREMENT BY 1;

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('STUDENT', 'ADMIN');

-- CreateEnum
CREATE TYPE "TestKind" AS ENUM ('REGULAR', 'PRACTICE');

-- CreateEnum
CREATE TYPE "TestStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CLOSED');

-- CreateEnum
CREATE TYPE "QuestionStatus" AS ENUM ('DRAFT', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "QuestionFormat" AS ENUM ('MCQ_SINGLE', 'MCQ_MULTI');

-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('IN_PROGRESS', 'SUBMITTED', 'AUTO_SUBMITTED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "GenerationStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "TagAxis" AS ENUM ('DIFFICULTY', 'COGNITIVE', 'SKILL');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL DEFAULT ('USR-'::text || lpad((nextval('user_public_id_seq'::regclass))::text, 5, '0'::text)),
    "username" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "grade" TEXT NOT NULL,
    "division" TEXT NOT NULL,
    "rollNo" TEXT NOT NULL,
    "dateOfBirth" DATE NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "role" "Role" NOT NULL DEFAULT 'STUDENT',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastLoginAt" TIMESTAMP(3),
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "passwordSetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "meta" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchoolClass" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "meta" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "SchoolClass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CurriculumNode" (
    "id" TEXT NOT NULL,
    "parentId" TEXT,
    "level" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "grade" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "meta" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "CurriculumNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "axis" "TagAxis" NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "weight" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "meta" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Question" (
    "id" TEXT NOT NULL,
    "status" "QuestionStatus" NOT NULL DEFAULT 'DRAFT',
    "format" "QuestionFormat" NOT NULL DEFAULT 'MCQ_SINGLE',
    "content" JSONB NOT NULL,
    "options" JSONB NOT NULL DEFAULT '[]',
    "answerKey" JSONB NOT NULL,
    "imageRequired" BOOLEAN NOT NULL DEFAULT false,
    "imagePrompt" JSONB,
    "imageFulfilled" BOOLEAN NOT NULL DEFAULT false,
    "explanation" JSONB NOT NULL DEFAULT '{"version":1,"blocks":[]}',
    "difficultyTag" TEXT NOT NULL,
    "cognitiveTag" TEXT NOT NULL,
    "skillTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "curriculumNodeId" TEXT,
    "subject" TEXT NOT NULL,
    "topic" TEXT,
    "subtopic" TEXT,
    "grade" TEXT,
    "estimatedSeconds" INTEGER NOT NULL DEFAULT 60,
    "generationRunId" TEXT,
    "sourceModel" TEXT,
    "isAdminEdited" BOOLEAN NOT NULL DEFAULT false,
    "reviewNote" TEXT,
    "timesServed" INTEGER NOT NULL DEFAULT 0,
    "timesCorrect" INTEGER NOT NULL DEFAULT 0,
    "observedP" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "contentVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "meta" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "Question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "altText" TEXT,
    "questionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "meta" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "systemPrompt" TEXT NOT NULL,
    "userTemplate" TEXT NOT NULL,
    "kind" "TestKind" NOT NULL DEFAULT 'REGULAR',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "PromptTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenerationRun" (
    "id" TEXT NOT NULL,
    "status" "GenerationStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptTemplateId" TEXT,
    "systemPrompt" TEXT NOT NULL,
    "userPrompt" TEXT NOT NULL,
    "requestSpec" JSONB NOT NULL,
    "kind" "TestKind" NOT NULL DEFAULT 'REGULAR',
    "targetUserId" TEXT,
    "rawResponse" TEXT,
    "errorMessage" TEXT,
    "parseAttempts" INTEGER NOT NULL DEFAULT 0,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "latencyMs" INTEGER,
    "questionsRequested" INTEGER NOT NULL DEFAULT 0,
    "questionsParsed" INTEGER NOT NULL DEFAULT 0,
    "questionsAccepted" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "meta" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "GenerationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiCredential" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "encryptedKey" TEXT NOT NULL,
    "keyHint" TEXT NOT NULL,
    "defaultModel" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "ApiCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Test" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL DEFAULT ('TST-'::text || lpad((nextval('test_public_id_seq'::regclass))::text, 4, '0'::text)),
    "title" TEXT NOT NULL,
    "description" TEXT,
    "kind" "TestKind" NOT NULL DEFAULT 'REGULAR',
    "status" "TestStatus" NOT NULL DEFAULT 'DRAFT',
    "subject" TEXT NOT NULL,
    "grade" TEXT,
    "targetGrades" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "targetDivisions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "targetUserId" TEXT,
    "marksPerQuestion" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "negativeMarks" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "durationMinutes" INTEGER NOT NULL DEFAULT 30,
    "maxAttempts" INTEGER NOT NULL DEFAULT 1,
    "passPercentage" DOUBLE PRECISION NOT NULL DEFAULT 35,
    "shuffleQuestions" BOOLEAN NOT NULL DEFAULT true,
    "shuffleOptions" BOOLEAN NOT NULL DEFAULT true,
    "showAnswersAfter" BOOLEAN NOT NULL DEFAULT true,
    "resultsReleased" BOOLEAN NOT NULL DEFAULT false,
    "resultsReleasedAt" TIMESTAMP(3),
    "releasedById" TEXT,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "meta" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "Test_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestQuestion" (
    "id" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "marks" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "TestQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attempt" (
    "id" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "AttemptStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "layout" JSONB NOT NULL DEFAULT '{}',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "maxScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "percentage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "correctCount" INTEGER NOT NULL DEFAULT 0,
    "incorrectCount" INTEGER NOT NULL DEFAULT 0,
    "unansweredCount" INTEGER NOT NULL DEFAULT 0,
    "breakdown" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "Attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Answer" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "response" JSONB,
    "isCorrect" BOOLEAN,
    "marksAwarded" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "timeSpentMs" INTEGER NOT NULL DEFAULT 0,
    "visitCount" INTEGER NOT NULL DEFAULT 0,
    "isMarkedForReview" BOOLEAN NOT NULL DEFAULT false,
    "answeredAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "Answer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackupArchive" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "isEncrypted" BOOLEAN NOT NULL DEFAULT false,
    "includesAssets" BOOLEAN NOT NULL DEFAULT true,
    "manifest" JSONB NOT NULL DEFAULT '{}',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "meta" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "BackupArchive_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT,
    "entityId" TEXT,
    "ip" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_publicId_key" ON "User"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "User_role_isActive_idx" ON "User"("role", "isActive");

-- CreateIndex
CREATE INDEX "User_grade_division_idx" ON "User"("grade", "division");

-- CreateIndex
CREATE INDEX "User_deletedAt_idx" ON "User"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_grade_division_rollNo_key" ON "User"("grade", "division", "rollNo");

-- CreateIndex
CREATE INDEX "SchoolClass_kind_isActive_sortOrder_idx" ON "SchoolClass"("kind", "isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "SchoolClass_kind_code_key" ON "SchoolClass"("kind", "code");

-- CreateIndex
CREATE INDEX "CurriculumNode_level_isActive_idx" ON "CurriculumNode"("level", "isActive");

-- CreateIndex
CREATE INDEX "CurriculumNode_path_idx" ON "CurriculumNode"("path");

-- CreateIndex
CREATE UNIQUE INDEX "CurriculumNode_parentId_code_key" ON "CurriculumNode"("parentId", "code");

-- CreateIndex
CREATE INDEX "Tag_axis_isActive_sortOrder_idx" ON "Tag"("axis", "isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_axis_code_key" ON "Tag"("axis", "code");

-- CreateIndex
CREATE INDEX "Question_status_subject_idx" ON "Question"("status", "subject");

-- CreateIndex
CREATE INDEX "Question_status_imageRequired_imageFulfilled_idx" ON "Question"("status", "imageRequired", "imageFulfilled");

-- CreateIndex
CREATE INDEX "Question_difficultyTag_cognitiveTag_idx" ON "Question"("difficultyTag", "cognitiveTag");

-- CreateIndex
CREATE INDEX "Question_subject_topic_subtopic_idx" ON "Question"("subject", "topic", "subtopic");

-- CreateIndex
CREATE INDEX "Question_generationRunId_idx" ON "Question"("generationRunId");

-- CreateIndex
CREATE INDEX "Question_skillTags_idx" ON "Question" USING GIN ("skillTags");

-- CreateIndex
CREATE INDEX "Asset_sha256_idx" ON "Asset"("sha256");

-- CreateIndex
CREATE INDEX "Asset_questionId_idx" ON "Asset"("questionId");

-- CreateIndex
CREATE INDEX "PromptTemplate_kind_isActive_idx" ON "PromptTemplate"("kind", "isActive");

-- CreateIndex
CREATE INDEX "GenerationRun_status_createdAt_idx" ON "GenerationRun"("status", "createdAt");

-- CreateIndex
CREATE INDEX "GenerationRun_requestedById_idx" ON "GenerationRun"("requestedById");

-- CreateIndex
CREATE INDEX "GenerationRun_targetUserId_idx" ON "GenerationRun"("targetUserId");

-- CreateIndex
CREATE INDEX "ApiCredential_provider_isActive_idx" ON "ApiCredential"("provider", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Test_publicId_key" ON "Test"("publicId");

-- CreateIndex
CREATE INDEX "Test_status_kind_startsAt_idx" ON "Test"("status", "kind", "startsAt");

-- CreateIndex
CREATE INDEX "Test_targetUserId_idx" ON "Test"("targetUserId");

-- CreateIndex
CREATE INDEX "Test_createdById_idx" ON "Test"("createdById");

-- CreateIndex
CREATE INDEX "TestQuestion_testId_position_idx" ON "TestQuestion"("testId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "TestQuestion_testId_questionId_key" ON "TestQuestion"("testId", "questionId");

-- CreateIndex
CREATE INDEX "Attempt_userId_status_idx" ON "Attempt"("userId", "status");

-- CreateIndex
CREATE INDEX "Attempt_testId_status_idx" ON "Attempt"("testId", "status");

-- CreateIndex
CREATE INDEX "Attempt_submittedAt_idx" ON "Attempt"("submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Attempt_testId_userId_attemptNumber_key" ON "Attempt"("testId", "userId", "attemptNumber");

-- CreateIndex
CREATE INDEX "Answer_questionId_isCorrect_idx" ON "Answer"("questionId", "isCorrect");

-- CreateIndex
CREATE UNIQUE INDEX "Answer_attemptId_questionId_key" ON "Answer"("attemptId", "questionId");

-- CreateIndex
CREATE INDEX "BackupArchive_createdAt_idx" ON "BackupArchive"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- AddForeignKey
ALTER TABLE "CurriculumNode" ADD CONSTRAINT "CurriculumNode_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "CurriculumNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_curriculumNodeId_fkey" FOREIGN KEY ("curriculumNodeId") REFERENCES "CurriculumNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_generationRunId_fkey" FOREIGN KEY ("generationRunId") REFERENCES "GenerationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationRun" ADD CONSTRAINT "GenerationRun_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationRun" ADD CONSTRAINT "GenerationRun_promptTemplateId_fkey" FOREIGN KEY ("promptTemplateId") REFERENCES "PromptTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Test" ADD CONSTRAINT "Test_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Test" ADD CONSTRAINT "Test_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestQuestion" ADD CONSTRAINT "TestQuestion_testId_fkey" FOREIGN KEY ("testId") REFERENCES "Test"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestQuestion" ADD CONSTRAINT "TestQuestion_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_testId_fkey" FOREIGN KEY ("testId") REFERENCES "Test"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Answer" ADD CONSTRAINT "Answer_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Answer" ADD CONSTRAINT "Answer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackupArchive" ADD CONSTRAINT "BackupArchive_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

