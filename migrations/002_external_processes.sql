-- 002_external_processes.sql

ALTER TABLE processes ADD COLUMN managed_by ENUM('agent', 'external') DEFAULT 'agent' AFTER max_restarts;
ALTER TABLE processes ADD COLUMN match_pattern VARCHAR(500) AFTER managed_by;
