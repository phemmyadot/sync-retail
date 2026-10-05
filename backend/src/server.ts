import { createServer } from 'node:http';
import { createApp } from './app';
import { env } from './lib/env';
import { prisma } from './lib/db';
import { attachDisplayRelay } from './ws';

const server = createServer(createApp());
attachDisplayRelay(server);

server.listen(env.PORT, () => {
  console.log(`▲ Sync Retail API on http://localhost:${env.PORT}  (ws relay at /ws)`);
});

const shutdown = async () => {
  server.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
