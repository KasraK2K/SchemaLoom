-- Phase 10c (docs/phase10/PROPOSE-FIRST.md §2): a change request that is forked but not yet
-- submitted. Its own migration: Postgres can't use a new enum value in the transaction that
-- adds it, and the next migration's index predicate does.
ALTER TYPE change_request_status ADD VALUE IF NOT EXISTS 'draft' BEFORE 'open';
