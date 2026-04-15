import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool, { testConnection } from './src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function migrate() {
  await testConnection();

  // Ensure migrations table exists
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const [applied] = await pool.execute('SELECT name FROM migrations ORDER BY id');
  const appliedNames = new Set(applied.map(r => r.name));

  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (appliedNames.has(file)) {
      console.log(`  ✓ ${file} (already applied)`);
      continue;
    }

    console.log(`  → Applying ${file}...`);
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

    // Split on semicolons, filter empty statements
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    for (const stmt of statements) {
      try {
        await pool.execute(stmt);
      } catch (err) {
        // Skip "already exists" errors for idempotency
        if (err.code === 'ER_TABLE_EXISTS_ERROR' || err.code === 'ER_DUP_KEYNAME') {
          console.log(`    (skipped: ${err.message})`);
        } else {
          throw err;
        }
      }
    }

    await pool.execute('INSERT INTO migrations (name) VALUES (?)', [file]);
    console.log(`  ✓ ${file} applied`);
  }

  console.log('\nMigrations complete.');
  process.exit(0);
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
