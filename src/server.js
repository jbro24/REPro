const path = require('node:path');
const { createApp } = require('./app');
const { createOmniRouteFromEnv } = require('./omniRoute');

const port = Number(process.env.PORT || 3000);
const databasePath = process.env.CC_DATABASE_PATH || path.join(process.cwd(), 'data', 'career-commander.sqlite');
const omniRoute = createOmniRouteFromEnv();
const server = createApp({ dbPath: databasePath, omniRoute, analystProvider: omniRoute });

server.listen(port, '127.0.0.1', () => {
  console.log(`Career Commander listening on http://127.0.0.1:${port}`);
});

function shutdown() {
  server.close(() => {
    server.database.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
