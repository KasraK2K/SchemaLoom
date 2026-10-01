-- AlterTable
ALTER TABLE "project_connections" ADD COLUMN     "drift_fingerprint" TEXT,
ADD COLUMN     "drift_schedule" TEXT NOT NULL DEFAULT 'off',
ADD COLUMN     "last_check_at" TIMESTAMPTZ(6),
ADD COLUMN     "last_check_status" TEXT,
ADD COLUMN     "last_check_summary" JSONB;

