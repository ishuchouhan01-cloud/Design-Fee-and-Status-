import 'dotenv/config';
import type { Config } from 'drizzle-kit';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is not set — drizzle-kit needs it to generate or push migrations.');
}

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  casing: 'snake_case',
  dbCredentials: { url },
  // Everything lives in the default schema; set a name here to namespace it.
  schemaFilter: ['public'],
} satisfies Config;
