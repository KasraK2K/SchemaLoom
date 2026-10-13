-- Roadmap 24: indexes for the foreign keys the 20261011100000 migration left unindexed
-- (cascades and SET NULL on delete, and the per-project / per-user lookups).
CREATE INDEX "ai_messages_integration_id_idx" ON "ai_messages"("integration_id");
CREATE INDEX "ai_integration_grants_project_id_idx" ON "ai_integration_grants"("project_id");
CREATE INDEX "ai_integration_grants_user_id_idx" ON "ai_integration_grants"("user_id");
CREATE INDEX "ai_ability_choices_project_id_idx" ON "ai_ability_choices"("project_id");
CREATE INDEX "ai_ability_choices_user_id_idx" ON "ai_ability_choices"("user_id");
CREATE INDEX "ai_ability_choices_integration_id_idx" ON "ai_ability_choices"("integration_id");
