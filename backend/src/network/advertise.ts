import { Bonjour, type Service } from 'bonjour-service';

/**
 * Announces this Main Register on the LAN as `_syncretail._tcp` so registers
 * can find it without typing an IP. TXT record:
 *   sid  store id (registers re-find "their" host by this after IP changes)
 *   v    app version   ·   api  protocol version
 */
let bonjour: Bonjour | null = null;
let service: Service | null = null;
let current: { name: string; port: number; storeId: string; version: string } | null = null;

export function advertise(opts: { storeName: string; port: number; storeId: string; version: string }) {
  current = { name: opts.storeName, port: opts.port, storeId: opts.storeId, version: opts.version };
  republish();
}

/** Call after the store name changes (setup, settings). */
export function refreshAdvertisement(storeName: string) {
  if (!current || current.name === storeName) return;
  current = { ...current, name: storeName };
  republish();
}

function republish() {
  if (!current) return;
  bonjour ??= new Bonjour();
  service?.stop?.();
  // Instance names must be unique on the network: suffix a short store id.
  const instance = `${current.name || 'Sync Retail'} · ${current.storeId.slice(0, 4).toUpperCase()}`;
  service = bonjour.publish({
    name: instance,
    type: 'syncretail',
    protocol: 'tcp',
    port: current.port,
    txt: { sid: current.storeId, v: current.version, api: '1' },
  });
  service.on('error', (err: Error) => console.error('mDNS advertise error:', err.message));
}

export function stopAdvertising(): Promise<void> {
  return new Promise((resolve) => {
    if (!bonjour) return resolve();
    bonjour.unpublishAll(() => {
      bonjour?.destroy();
      bonjour = null;
      service = null;
      resolve();
    });
    setTimeout(resolve, 1500); // never block shutdown on the network
  });
}
