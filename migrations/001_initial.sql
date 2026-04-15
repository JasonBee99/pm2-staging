-- 001_initial.sql

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('admin', 'viewer') DEFAULT 'viewer',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS servers (
  id CHAR(36) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  hostname VARCHAR(255),
  ip_address VARCHAR(45),
  agent_token VARCHAR(128) UNIQUE NOT NULL,
  last_seen_at TIMESTAMP NULL,
  status ENUM('online', 'offline', 'stale') DEFAULT 'offline',
  os_info VARCHAR(255),
  agent_version VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS processes (
  id CHAR(36) PRIMARY KEY,
  server_id CHAR(36) NOT NULL,
  name VARCHAR(100) NOT NULL,
  command TEXT NOT NULL,
  cwd VARCHAR(500),
  env_vars JSON,
  autorestart BOOLEAN DEFAULT TRUE,
  max_restarts INT DEFAULT 10,
  status ENUM('running', 'stopped', 'crashed', 'restarting') DEFAULT 'stopped',
  pid INT,
  restart_count INT DEFAULT 0,
  uptime_started_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
  UNIQUE KEY uq_server_process (server_id, name)
);

CREATE TABLE IF NOT EXISTS metrics (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  process_id CHAR(36) NOT NULL,
  recorded_at TIMESTAMP(3) NOT NULL,
  cpu_pct FLOAT,
  mem_bytes BIGINT,
  INDEX idx_metrics_process_time (process_id, recorded_at),
  INDEX idx_metrics_time (recorded_at),
  FOREIGN KEY (process_id) REFERENCES processes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS metrics_hourly (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  process_id CHAR(36) NOT NULL,
  hour TIMESTAMP NOT NULL,
  avg_cpu FLOAT,
  max_cpu FLOAT,
  avg_mem BIGINT,
  max_mem BIGINT,
  sample_count INT,
  UNIQUE KEY uq_process_hour (process_id, hour),
  FOREIGN KEY (process_id) REFERENCES processes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  process_id CHAR(36) NOT NULL,
  occurred_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  kind ENUM('start', 'stop', 'crash', 'restart', 'oom', 'config_change') NOT NULL,
  exit_code INT,
  message TEXT,
  INDEX idx_events_process_time (process_id, occurred_at),
  FOREIGN KEY (process_id) REFERENCES processes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS log_lines (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  process_id CHAR(36) NOT NULL,
  logged_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),
  stream ENUM('stdout', 'stderr') NOT NULL,
  line TEXT,
  INDEX idx_logs_process_time (process_id, logged_at),
  FOREIGN KEY (process_id) REFERENCES processes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS alerts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  server_id CHAR(36),
  process_id CHAR(36),
  condition_type ENUM('mem_above', 'cpu_above', 'crash', 'restart_loop', 'offline') NOT NULL,
  threshold_value BIGINT,
  channel ENUM('email', 'webhook', 'discord') NOT NULL,
  target VARCHAR(500) NOT NULL,
  enabled BOOLEAN DEFAULT TRUE,
  cooldown_minutes INT DEFAULT 15,
  last_triggered_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id VARCHAR(128) PRIMARY KEY,
  expires INT UNSIGNED NOT NULL,
  data MEDIUMTEXT,
  INDEX idx_sessions_expires (expires)
);

CREATE TABLE IF NOT EXISTS migrations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
