import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_PATHS = [
  path.join(process.cwd(), '.monitorrc.json'),
  path.join(os.homedir(), '.monitorrc.json'),
  '/etc/monitor-agent.json',
];

let config = null;

export function loadConfig() {
  for (const p of CONFIG_PATHS) {
    if (fs.existsSync(p)) {
      try {
        config = JSON.parse(fs.readFileSync(p, 'utf8'));
        console.log(`✓ Config loaded from ${p}`);
        break;
      } catch (err) {
        console.error(`✗ Failed to parse ${p}:`, err.message);
      }
    }
  }

  if (!config) {
    console.error('✗ No config file found. Searched:', CONFIG_PATHS.join(', '));
    console.error('  Create ~/.monitorrc.json with central_url and agent_token');
    process.exit(1);
  }

  // Validate required fields
  if (!config.central_url) {
    console.error('✗ central_url is required in config');
    process.exit(1);
  }
  if (!config.agent_token) {
    console.error('✗ agent_token is required in config');
    process.exit(1);
  }

  // Defaults
  config.server_name = config.server_name || os.hostname();
  config.heartbeat_interval_ms = config.heartbeat_interval_ms || 10000;
  config.metrics_interval_ms = config.metrics_interval_ms || 5000;
  config.log_buffer_size = config.log_buffer_size || 50;
  config.log_dir = config.log_dir || path.join(os.homedir(), '.monitor-agent', 'logs');
  config.reconnect_interval_ms = config.reconnect_interval_ms || 5000;

  // Ensure log dir exists
  fs.mkdirSync(config.log_dir, { recursive: true });

  return config;
}

export function getConfig() {
  if (!config) loadConfig();
  return config;
}
