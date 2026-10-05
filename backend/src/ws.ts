import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { verifySession } from './services/tokens';

/**
 * Relay for the customer-facing display when it runs on a *different device*
 * (same-machine windows use BroadcastChannel and never touch the server).
 *
 *   ws://host/ws?terminal=T1&token=<jwt>   → may publish (agent terminal)
 *   ws://host/ws?terminal=T1               → subscribe only (display)
 */
export function attachDisplayRelay(server: Server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const rooms = new Map<string, Set<WebSocket>>();
  const lastMessage = new Map<string, string>();

  wss.on('connection', (socket, req) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const terminal = (url.searchParams.get('terminal') ?? '').slice(0, 40);
    if (!terminal) return socket.close(4400, 'terminal required');
    const token = url.searchParams.get('token');
    const canPublish = !!token && !!verifySession(token);

    const room = rooms.get(terminal) ?? new Set<WebSocket>();
    rooms.set(terminal, room);
    room.add(socket);

    // Late joiners immediately see the current cart.
    const last = lastMessage.get(terminal);
    if (last && !canPublish) socket.send(last);

    socket.on('message', (data) => {
      if (!canPublish) return;
      const text = data.toString();
      if (text.length > 64_000) return;
      lastMessage.set(terminal, text);
      for (const peer of room) if (peer !== socket && peer.readyState === peer.OPEN) peer.send(text);
    });

    socket.on('close', () => {
      room.delete(socket);
      if (!room.size) rooms.delete(terminal);
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) client.ping();
  }, 30_000);
  wss.on('close', () => clearInterval(heartbeat));
  return wss;
}
