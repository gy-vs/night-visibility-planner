import { createApp } from './app.js';
import { openDb } from './db.js';

const port = Number(process.env.PORT ?? 8787);
const dbPath = process.env.DB_PATH ?? new URL('../data.sqlite', import.meta.url).pathname;

const app = createApp(openDb(dbPath));
app.listen(port, () => {
  console.log(`[server] listening on http://localhost:${port} (db: ${dbPath})`);
});
