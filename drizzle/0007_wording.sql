-- Wording only: import-issue messages written by an earlier version.
UPDATE "drawing_import_issues" SET "message" = replace("message", 'shown in DFS under "Not mapped to the base DFS", with no billing scope.', 'shown in the Design Fee Schedule under "Drawings not assigned to a package", with no design fee.') WHERE "message" LIKE '%Not mapped to the base DFS%';
--> statement-breakpoint
UPDATE "drawing_import_issues" SET "message" = replace("message", 'shown under "Not mapped to the base DFS".', 'shown under "Drawings not assigned to a package".') WHERE "message" LIKE '%Not mapped to the base DFS%';
