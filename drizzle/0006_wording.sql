-- Wording only: an import-log message written by an earlier version.
UPDATE "import_issues" SET "message" = replace("message", 'links derived from the numbered batch sequence', 'links set from the numbered batch sequence') WHERE "message" LIKE '%links derived from the numbered batch sequence%';
