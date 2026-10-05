-- Roadmap 21b: a change request an AI agent proposed through an API token.
ALTER TABLE change_requests
  ADD COLUMN via_token_id TEXT REFERENCES api_tokens (id) ON DELETE SET NULL;

-- The per-token cap on open proposals counts by it.
CREATE INDEX change_requests_via_token_id_status_idx ON change_requests (via_token_id, status);
