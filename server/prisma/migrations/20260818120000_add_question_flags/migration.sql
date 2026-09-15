-- CreateEnum
CREATE TYPE "FlagStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- CreateTable
CREATE TABLE "QuestionFlag" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "flaggedById" TEXT NOT NULL,
    "attemptId" TEXT,
    "category" VARCHAR(40),
    "reason" TEXT,
    "status" "FlagStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "QuestionFlag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QuestionFlag_questionId_testId_flaggedById_key" ON "QuestionFlag"("questionId", "testId", "flaggedById");
CREATE INDEX "QuestionFlag_testId_status_idx" ON "QuestionFlag"("testId", "status");
CREATE INDEX "QuestionFlag_questionId_status_idx" ON "QuestionFlag"("questionId", "status");
CREATE INDEX "QuestionFlag_flaggedById_idx" ON "QuestionFlag"("flaggedById");
CREATE INDEX "QuestionFlag_testId_questionId_idx" ON "QuestionFlag"("testId", "questionId");
CREATE INDEX "QuestionFlag_status_createdAt_idx" ON "QuestionFlag"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "QuestionFlag" ADD CONSTRAINT "QuestionFlag_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuestionFlag" ADD CONSTRAINT "QuestionFlag_testId_fkey" FOREIGN KEY ("testId") REFERENCES "Test"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuestionFlag" ADD CONSTRAINT "QuestionFlag_flaggedById_fkey" FOREIGN KEY ("flaggedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuestionFlag" ADD CONSTRAINT "QuestionFlag_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "QuestionFlag" ADD CONSTRAINT "QuestionFlag_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
