-- DropForeignKey
ALTER TABLE "access_grants" DROP CONSTRAINT "access_grants_role_id_fkey";

-- DropForeignKey
ALTER TABLE "custom_types" DROP CONSTRAINT "custom_types_namespace_id_fkey";

-- DropForeignKey
ALTER TABLE "entities" DROP CONSTRAINT "entities_namespace_id_fkey";

-- DropForeignKey
ALTER TABLE "fields" DROP CONSTRAINT "fields_custom_type_id_fkey";

-- DropForeignKey
ALTER TABLE "fields" DROP CONSTRAINT "fields_parent_same_entity_fk";

-- DropForeignKey
ALTER TABLE "projects" DROP CONSTRAINT "projects_workspace_id_fkey";

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entities" ADD CONSTRAINT "entities_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "namespaces"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fields" ADD CONSTRAINT "fields_custom_type_id_fkey" FOREIGN KEY ("custom_type_id") REFERENCES "custom_types"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_types" ADD CONSTRAINT "custom_types_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "namespaces"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
