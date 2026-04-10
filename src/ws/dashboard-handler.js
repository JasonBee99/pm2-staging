// Connected dashboard clients
const dashboardClients = new Set();

// Subscriptions: which process_ids each client is watching
const clientSubscriptions = new WeakMap();

export function broadcastToDashboard(message) {
  const data = JSON.stringify(message);
  for (const client of dashboardClients) {
    if (client.readyState === 1) {
      // If it's a metrics_tick or log_line, check subscription
      if (message.type === 'metrics_tick' || message.type === 'log_line') {
        const subs = clientSubscriptions.get(client);
        if (subs && !subs.has(message.process_id)) continue;
      }
      try {
        client.send(data);
      } catch {}
    }
  }
}

export default async function dashboardWsHandler(fastify) {
  fastify.get('/ws/dashboard', { websocket: true }, (socket, request) => {
    dashboardClients.add(socket);
    clientSubscriptions.set(socket, new Set());

    socket.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const subs = clientSubscriptions.get(socket) || new Set();

      switch (msg.type) {
        case 'subscribe_metrics':
        case 'subscribe_logs':
          if (Array.isArray(msg.process_ids)) {
            for (const id of msg.process_ids) subs.add(id);
          } else if (msg.process_id) {
            subs.add(msg.process_id);
          }
          clientSubscriptions.set(socket, subs);
          break;

        case 'unsubscribe_metrics':
        case 'unsubscribe_logs':
          if (Array.isArray(msg.process_ids)) {
            for (const id of msg.process_ids) subs.delete(id);
          } else if (msg.process_id) {
            subs.delete(msg.process_id);
          }
          break;

        case 'subscribe_all':
          // Special: receive all updates (for overview dashboard)
          clientSubscriptions.set(socket, null); // null = all
          break;
      }
    });

    socket.on('close', () => {
      dashboardClients.delete(socket);
    });

    socket.on('error', () => {
      dashboardClients.delete(socket);
    });
  });
}
