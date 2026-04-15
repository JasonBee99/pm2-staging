import pool from '../db.js';

/**
 * Minimal MySQL session store compatible with @fastify/session.
 * Implements get, set, destroy methods using the sessions table.
 */
export default class MysqlSessionStore {
  constructor() {
    this.pool = pool;
  }

  async get(sessionId, callback) {
    try {
      const [rows] = await this.pool.execute(
        'SELECT data FROM sessions WHERE session_id = ? AND expires > UNIX_TIMESTAMP()',
        [sessionId]
      );
      if (rows.length === 0) {
        callback(null, null);
        return;
      }
      const data = JSON.parse(rows[0].data);
      callback(null, data);
    } catch (err) {
      callback(err);
    }
  }

  async set(sessionId, session, callback) {
    try {
      const maxAge = session.cookie?.maxAge || 86400000;
      const expires = Math.floor(Date.now() / 1000) + Math.floor(maxAge / 1000);
      const data = JSON.stringify(session);

      await this.pool.execute(
        `INSERT INTO sessions (session_id, expires, data) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE expires = VALUES(expires), data = VALUES(data)`,
        [sessionId, expires, data]
      );
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  async destroy(sessionId, callback) {
    try {
      await this.pool.execute('DELETE FROM sessions WHERE session_id = ?', [sessionId]);
      if (callback) callback(null);
    } catch (err) {
      if (callback) callback(err);
    }
  }
}
