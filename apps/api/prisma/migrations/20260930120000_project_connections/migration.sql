-- CreateTable
CREATE TABLE "project_connections" (
    "project_id" TEXT NOT NULL,
    "engine_id" TEXT NOT NULL,
    "encrypted" TEXT NOT NULL,
    "saved_by_id" TEXT,
    "saved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6),

    CONSTRAINT "project_connections_pkey" PRIMARY KEY ("project_id")
);

-- AddForeignKey
ALTER TABLE "project_connections" ADD CONSTRAINT "project_connections_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_connections" ADD CONSTRAINT "project_connections_saved_by_id_fkey" FOREIGN KEY ("saved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

