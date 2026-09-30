/**
 * Design Goals FY 26 importer CLI.
 *
 *   npm run fy26:import              preview — reads everything, writes nothing
 *   npm run fy26:import -- --preview same, stated explicitly
 *   npm run fy26:import -- --apply   write the hierarchy
 *   npm run fy26:import -- --dir <folder>
 *   npm run fy26:import -- --apply --rebuild
 *                                    clear the FY26 module's own tables first
 *                                    and re-import from scratch. Touches ONLY
 *                                    the four fy26_* hierarchy tables; every
 *                                    other table, including `projects`,
 *                                    `goals` and `design_deliverables`, is left
 *                                    alone. Manual edits and manually added
 *                                    dependencies in the FY26 module are lost,
 *                                    so it asks for --yes as well.
 *
 * The source folder comes from --dir, then FY26_SOURCE_DIR, then data/fy26.
 * No path is hard-coded to any machine.
 */
import 'dotenv/config';
import { closeDb, db } from '../src/db';
import {
  fy26PackageDependencies,
  fy26Packages,
  fy26Phases,
  fy26Projects,
} from '../src/db/schema';
import { formatImportSummary, runFy26Import } from '../src/lib/import/design-goals-fy26';

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const rebuild = argv.includes('--rebuild');
  if (apply && argv.includes('--preview')) {
    console.error('--preview and --apply are mutually exclusive. Run the preview first, then --apply on its own.');
    process.exitCode = 1;
    return;
  }
  const dirFlag = argv.indexOf('--dir');
  const sourceDir = dirFlag >= 0 ? argv[dirFlag + 1] : undefined;

  if (rebuild) {
    if (!apply) {
      console.error('--rebuild only makes sense with --apply.');
      process.exitCode = 1;
      return;
    }
    if (!argv.includes('--yes')) {
      console.error(
        'Refusing to rebuild without --yes.\n' +
          'This deletes every row in fy26_packages, fy26_package_dependencies, fy26_phases and\n' +
          'fy26_projects, including any edits made in the application and any dependencies added\n' +
          'through "+ Add Dependency". No other table is touched.',
      );
      process.exitCode = 1;
      return;
    }
    await db.delete(fy26PackageDependencies);
    await db.delete(fy26Packages);
    await db.delete(fy26Phases);
    await db.delete(fy26Projects);
    console.log('Rebuild  : cleared the four FY26 hierarchy tables (no other table touched)\n');
  }

  const result = await runFy26Import({ apply, sourceDir });
  console.log(formatImportSummary(result));

  if (!result.valid) {
    console.error('\nImport did not validate. The differences above are not explained away — nothing is "successful".');
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
