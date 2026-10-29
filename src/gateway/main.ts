import { readSettings, startDaemon } from './daemon';

/** `npm run gateway` — secrets come from the environment (in AWS: injected from Secrets Manager), never from files in the repo. */
async function main(): Promise<void> {
  const settings = readSettings(process.env);
  const d = await startDaemon(settings);
  const quit = (sig: string) => { console.log(JSON.stringify({ level: 'info', msg: 'shutting down', sig })); d.stop().finally(() => process.exit(0)); };
  process.on('SIGTERM', () => quit('SIGTERM'));
  process.on('SIGINT', () => quit('SIGINT'));
}
main().catch((e) => { console.error(JSON.stringify({ level: 'fatal', msg: (e as Error).message })); process.exit(1); });
