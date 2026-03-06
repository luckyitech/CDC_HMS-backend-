// ============================================================
// SSE Manager — Server-Sent Events client registry
// Keeps track of all connected browser clients and broadcasts
// named events to them whenever queue data changes.
// ============================================================

const clients = new Set();

// Register a new SSE client (the response stream)
const addClient = (res) => {
  clients.add(res);
  res.on('close', () => clients.delete(res));
};

// Broadcast a named event to every connected client
const broadcast = (event, data = {}) => {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach((client) => {
    try {
      client.write(msg);
    } catch (_) {
      // Client disconnected before 'close' fired — clean it up
      clients.delete(client);
    }
  });
};

module.exports = { addClient, broadcast };
