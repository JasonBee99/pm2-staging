import mysql from 'mysql2/promise';
import config from './config.js';

const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  timezone: '+00:00',
});

// Test connection on startup
export async function testConnection() {
  try {
    const conn = await pool.getConnection();
    console.log('✓ MySQL connected:', config.db.host, '/', config.db.database);
    conn.release();
  } catch (err) {
    console.error('✗ MySQL connection failed:', err.message);
    process.exit(1);
  }
}

export default pool;
