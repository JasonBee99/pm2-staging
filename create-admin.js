import readline from 'readline';
import bcrypt from 'bcryptjs';
import pool, { testConnection } from './src/db.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));

async function createAdmin() {
  await testConnection();

  const email = await ask('Admin email: ');
  const password = await ask('Admin password: ');

  if (!email || !password) {
    console.error('Email and password are required.');
    process.exit(1);
  }

  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);

  try {
    await pool.execute(
      'INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)',
      [email, hash, 'admin']
    );
    console.log(`\n✓ Admin user created: ${email}`);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      console.error(`\n✗ User ${email} already exists.`);
    } else {
      throw err;
    }
  }

  rl.close();
  process.exit(0);
}

createAdmin().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
