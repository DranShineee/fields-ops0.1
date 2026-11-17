import app from './app.js';
import { config } from './config.js';
import { pool } from './db.js';

const server = app.listen(config.port, () => {
  console.log(
    `FieldsOps berjalan di http://localhost:${config.port} (${config.env}) — database: ${config.db.database}`,
  );
});

function shutdown(signal) {
  console.log(`\n${signal} diterima, menutup server...`);
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 8000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export default app;
