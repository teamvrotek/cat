import streamDeck, { SingletonAction } from '@elgato/streamdeck';
import { registerControl } from './controller.js';

const runtime = registerControl(streamDeck, SingletonAction);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await runtime.dispose();
  process.exit(0);
}
process.once('SIGINT', () => { stop().catch(error => { streamDeck.logger.error(error); process.exit(1); }); });
process.once('SIGTERM', () => { stop().catch(error => { streamDeck.logger.error(error); process.exit(1); }); });
try { await streamDeck.connect(); }
catch (error) {
  streamDeck.logger.error('Cat could not connect:', error?.message || error);
  await runtime.dispose();
  process.exitCode = 1;
}
