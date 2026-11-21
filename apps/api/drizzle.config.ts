import { defineConfig } from 'drizzle-kit';

function resolveMigrationDatabaseUrl(): string {
  const raw = process.env['DATABASE_URL'];
  if (!raw || raw.trim().length === 0) {
    // Allows offline `drizzle-kit generate`; `drizzle-kit migrate` still requires a live Neon URL.
    return 'postgresql://localhost:5432/clairflux?sslmode=require';
  }

  const parsed = new URL(raw);
  if (parsed.searchParams.get('sslmode') !== 'require') {
    throw new Error('DATABASE_URL must specify sslmode=require for Neon PostgreSQL.');
  }
  return raw;
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: resolveMigrationDatabaseUrl(),
  },
  strict: true,
  verbose: true,
});
