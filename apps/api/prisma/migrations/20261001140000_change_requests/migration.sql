-- CreateEnum
CREATE TYPE "change_request_status" AS ENUM ('open', 'merged', 'closed');

-- CreateEnum
CREATE TYPE "review_verdict" AS ENUM ('approved', 'changes_requested');

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "draft_of_id" TEXT;

-- CreateTable
CREATE TABLE "change_requests" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "draft_project_id" TEXT NOT NULL,
    "author_id" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "change_request_status" NOT NULL DEFAULT 'open',
    "base_snapshot_id" TEXT NOT NULL,
    "id_map" JSONB NOT NULL,
    "reviewer_ids" TEXT[],
    "merged_by_id" TEXT,
    "merged_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_request_reviews" (
    "id" TEXT NOT NULL,
    "change_request_id" TEXT NOT NULL,
    "reviewer_id" TEXT,
    "verdict" "review_verdict" NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "draft_revision" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "change_request_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "change_requests_draft_project_id_key" ON "change_requests"("draft_project_id");

-- CreateIndex
CREATE INDEX "change_requests_project_id_status_created_at_idx" ON "change_requests"("project_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "change_request_reviews_change_request_id_created_at_idx" ON "change_request_reviews"("change_request_id", "created_at");

-- CreateIndex
CREATE INDEX "projects_draft_of_id_idx" ON "projects"("draft_of_id");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_draft_of_id_fkey" FOREIGN KEY ("draft_of_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_draft_project_id_fkey" FOREIGN KEY ("draft_project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_request_reviews" ADD CONSTRAINT "change_request_reviews_change_request_id_fkey" FOREIGN KEY ("change_request_id") REFERENCES "change_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_request_reviews" ADD CONSTRAINT "change_request_reviews_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

