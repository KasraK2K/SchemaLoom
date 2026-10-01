-- The base lives on the request: auto snapshots are pruned.
ALTER TABLE "change_requests" DROP COLUMN "base_snapshot_id",
ADD COLUMN     "base_ir" JSONB NOT NULL;
