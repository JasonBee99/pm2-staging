import { spawn } from 'child_process';

/**
 * Run a deploy sequence: git pull, then build command.
 * Streams output line-by-line via onOutput callback.
 * Returns { success, exitCode } when done.
 */
export async function runDeploy({ cwd, buildCommand, env, onOutput, onDone }) {
  const emit = (stream, line) => {
    if (onOutput) onOutput(stream, line);
  };

  // Helper to run one command and wait for completion
  const runCommand = (cmd, args, label) => {
    return new Promise((resolve) => {
      emit('stdout', `\n━━━ ${label}: ${cmd} ${args.join(' ')} ━━━`);

      const child = spawn(cmd, args, {
        cwd,
        env: { ...process.env, ...(env || {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (data) => {
        data.toString().split('\n').filter(l => l.length > 0).forEach(l => emit('stdout', l));
      });

      child.stderr.on('data', (data) => {
        data.toString().split('\n').filter(l => l.length > 0).forEach(l => emit('stderr', l));
      });

      child.on('error', (err) => {
        emit('stderr', `Error: ${err.message}`);
        resolve({ success: false, exitCode: -1 });
      });

      child.on('exit', (code) => {
        if (code === 0) {
          emit('stdout', `✓ ${label} completed`);
          resolve({ success: true, exitCode: code });
        } else {
          emit('stderr', `✗ ${label} failed with exit code ${code}`);
          resolve({ success: false, exitCode: code });
        }
      });
    });
  };

  // Step 1: git pull
  const gitResult = await runCommand('git', ['pull'], 'git pull');
  if (!gitResult.success) {
    if (onDone) onDone({ success: false, stage: 'git', exitCode: gitResult.exitCode });
    return;
  }

  // Step 2: build (if configured)
  if (buildCommand && buildCommand.trim()) {
    const parts = buildCommand.trim().split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);
    const buildResult = await runCommand(cmd, args, 'build');
    if (!buildResult.success) {
      if (onDone) onDone({ success: false, stage: 'build', exitCode: buildResult.exitCode });
      return;
    }
  } else {
    emit('stdout', '(no build command configured — skipping build)');
  }

  if (onDone) onDone({ success: true });
}
