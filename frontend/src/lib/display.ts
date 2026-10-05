import type { DisplayMessage } from '@sync-retail/shared';
import { TERMINAL_ID, wsUrl } from './config';
import { useAuth } from '@/store/auth';

const CHANNEL = `sync-retail-display:${TERMINAL_ID}`;

/**
 * Agent → customer display transport.
 *  • BroadcastChannel: second window/monitor on the same machine (web or Tauri).
 *  • WebSocket relay:  display running on another device (tablet on the counter).
 */
export class DisplayPublisher {
  private bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null;
  private ws: WebSocket | null = null;
  private last: DisplayMessage | null = null;
  private retry?: number;
  private active = true;

  constructor() {
    // A display that opens late says hello; answer with the current state.
    this.bc?.addEventListener('message', (e) => {
      if ((e.data as DisplayMessage)?.type === 'hello' && this.last) this.bc?.postMessage(this.last);
    });
    this.connect();
  }

  private connect() {
    const token = useAuth.getState().token;
    if (!token || !this.active) return;
    try {
      this.ws = new WebSocket(wsUrl(`/ws?terminal=${encodeURIComponent(TERMINAL_ID)}&token=${encodeURIComponent(token)}`));
      this.ws.onopen = () => {
        if (this.last) this.ws?.send(JSON.stringify(this.last));
      };
      this.ws.onclose = () => {
        this.ws = null;
        if (this.active) this.retry = window.setTimeout(() => this.connect(), 8000);
      };
    } catch {
      /* relay unavailable — BroadcastChannel still works */
    }
  }

  send(msg: DisplayMessage) {
    this.last = msg;
    this.bc?.postMessage(msg);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close() {
    this.active = false;
    window.clearTimeout(this.retry);
    this.bc?.close();
    this.ws?.close();
  }
}

export function subscribeDisplay(onMessage: (m: DisplayMessage) => void, opts: { relay: boolean }) {
  const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null;
  bc?.addEventListener('message', (e) => onMessage(e.data as DisplayMessage));
  bc?.postMessage({ type: 'hello' } satisfies DisplayMessage);

  let ws: WebSocket | null = null;
  let stopped = false;
  let retry: number | undefined;
  const connect = () => {
    if (!opts.relay || stopped) return;
    ws = new WebSocket(wsUrl(`/ws?terminal=${encodeURIComponent(TERMINAL_ID)}`));
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data as string) as DisplayMessage);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (!stopped) retry = window.setTimeout(connect, 3000);
    };
  };
  connect();

  return () => {
    stopped = true;
    window.clearTimeout(retry);
    bc?.close();
    ws?.close();
  };
}
