-- Phase 10c §2: one unsubmitted draft per author per project. Proposing again returns it.
CREATE UNIQUE INDEX change_requests_one_draft_uq
  ON change_requests (project_id, author_id) WHERE status = 'draft';
