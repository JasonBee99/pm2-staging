import 'dotenv/config';

export default {
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306'),
    database: process.env.DB_NAME || 'pm2data',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
  },
  server: {
    port: parseInt(process.env.PORT || '3000'),
    host: process.env.HOST || '0.0.0.0',
  },
  session: {
    secret: process.env.SESSION_SECRET || 'change-me-in-production',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
  isProduction: process.env.NODE_ENV === 'production',
};
