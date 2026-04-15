-- 004_deploy.sql

ALTER TABLE processes ADD COLUMN build_command VARCHAR(500) DEFAULT NULL AFTER env_vars;
