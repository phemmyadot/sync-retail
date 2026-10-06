import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { verifySession } from './services/tokens';
import { checkDeviceToken, hostMode, isLoopback } from './network/deviceAuth';

// Store-wide channel: registers subscribe for live updates (held-sales count).
const storeSockets = new Set<WebSocket>();

/** Pushes a small JSON event to every signed-in register. */
export function publishStore(msg: object) {
  const text = JSON.stringify(msg);
  for (const s of storeSockets) if (s.readyState === s.OPEN) s.send(text);
}

/**
 * Relay for the customer-facing display when it runs on a *different device*
 * (same-machine windows use BroadcastChannel and never touch the server).
 *
 *   ws://host/ws?terminal=T1&token=<jwt>   → may publish (agent terminal)
 *   ws://host/ws?terminal=T1               → subscribe only (display)
 */
export function attachDisplayRelay(server: Server) {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    // Desktop host mode: sockets from other machines must belong to a paired
    // device. Checked during the HTTP upgrade, so a refused client never connects.
    verifyClient: (info, done) => {
      if (!hostMode() || isLoopback(info.req.socket.remoteAddress)) return done(true);
      const device = new URL(info.req.url ?? '', 'http://localhost').searchParams.get('device') ?? undefined;
      checkDeviceToken(device)
        .then((d) => (d.ok ? done(true) : done(false, 401, d.code)))
        .catch(() => done(false, 500));
    },
  });
  const rooms = new Map<string, Set<WebSocket>>();
  const lastMessage = new Map<string, string>();

  wss.on('connection', (socket, req) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    //   ws://host/ws?channel=store&token=<jwt>   → store events (subscribe only)
    if (url.searchParams.get('channel') === 'store') {
      const t = url.searchParams.get('token');
      if (!t || !verifySession(t)) return socket.close(4401, 'session required');
      storeSockets.add(socket);
      socket.on('close', () => storeSockets.delete(socket));
      return;
    }
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
