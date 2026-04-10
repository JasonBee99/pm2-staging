import path from 'path';
import { fileURLToPath } from 'url';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';

import config from './config.js';
import { testConnection } from './db.js';
import MysqlSessionStore from './services/mysql-session-store.js';
import { startCleanupJobs } from './services/cleanup-jobs.js';
import { startAlertEngine } from './services/alert-engine.js';

// Routes
import authRoutes from './routes/auth.js';
import agentRoutes from './routes/agent.js';
import serverRoutes from './routes/servers.js';
import processRoutes from './routes/processes.js';
import metricsRoutes from './routes/metrics.js';
import alertRoutes from './routes/alerts.js';

// WebSocket handlers
import agentWsHandler from './ws/agent-handler.js';
import dashboardWsHandler from './ws/dashboard-handler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function start() {
  // Test DB connection
  await testConnection();

  const fastify = Fastify({
    logger: config.isProduction
      ? { level: 'info' }
      : { level: 'info', transport: { target: 'pino-pretty' } },
    trustProxy: true, // Behind DreamHost proxy
  });

  // CORS (allow dashboard dev server in development)
  await fastify.register(fastifyCors, {
    origin: config.isProduction ? false : ['http://localhost:5173'],
    credentials: true,
  });

  // Cookie + Session
  await fastify.register(fastifyCookie);
  await fastify.register(fastifySession, {
    secret: config.session.secret,
    store: new MysqlSessionStore(),
    cookie: {
      maxAge: config.session.maxAge,
      httpOnly: true,
      secure: config.isProduction,
      sameSite: 'lax',
      path: '/',
    },
    saveUninitialized: false,
  });

  // WebSocket
  await fastify.register(fastifyWebsocket);

  // API Routes
  await fastify.register(authRoutes);
  await fastify.register(agentRoutes);
  await fastify.register(serverRoutes);
  await fastify.register(processRoutes);
  await fastify.register(metricsRoutes);
  await fastify.register(alertRoutes);

  // WebSocket Routes
  await fastify.register(agentWsHandler);
  await fastify.register(dashboardWsHandler);

  // Serve React dashboard (production)
  const dashboardPath = path.join(__dirname, '..', 'dashboard', 'dist');
  await fastify.register(fastifyStatic, {
    root: dashboardPath,
    prefix: '/',
    wildcard: false,
  });

  // SPA fallback: serve index.html for any non-API, non-WS route
  fastify.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/ws/')) {
      reply.code(404).send({ error: 'Not found' });
    } else {
      reply.sendFile('index.html');
    }
  });

  // Health check
  fastify.get('/api/health', async () => ({ status: 'ok', uptime: process.uptime() }));

  // Start cleanup jobs
  startCleanupJobs();

  // Start alert engine
  startAlertEngine();

  // Start server
  try {
    await fastify.listen({ port: config.server.port, host: config.server.host });
    console.log(`\n🖥  Monitor Central running on port ${config.server.port}`);
    console.log(`   Dashboard: https://pm2.javawav.com`);
    console.log(`   Agent WS:  wss://pm2.javawav.com/ws/agent`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
