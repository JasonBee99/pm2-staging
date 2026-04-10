import { v4 as uuidv4 } from 'uuid';

// In-memory command queue per server.
// Commands are pushed by dashboard actions and drained by agent heartbeat or WS.
class CommandQueue {
  constructor() {
    this.queues = new Map(); // server_id -> [{ id, action, process_id, ... }]
  }

  push(serverId, command) {
    if (!this.queues.has(serverId)) {
      this.queues.set(serverId, []);
    }
    const cmd = { id: uuidv4(), ...command, queued_at: Date.now() };
    this.queues.get(serverId).push(cmd);

    // Also try to send via WebSocket if agent is connected
    if (this.wsSend) {
      this.wsSend(serverId, cmd);
    }

    return cmd;
  }

  drain(serverId) {
    const commands = this.queues.get(serverId) || [];
    this.queues.delete(serverId);
    return commands;
  }

  // Set by ws/agent-handler.js to enable real-time dispatch
  setWsSender(fn) {
    this.wsSend = fn;
  }
}

export const commandQueue = new CommandQueue();
