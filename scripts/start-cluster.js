const cluster = require('node:cluster');
const os = require('node:os');

const workers = Number(process.env.WEB_CONCURRENCY || Math.min(os.cpus().length, 4));

if (cluster.isPrimary && workers > 1) {
  console.log(`Starting ${workers} Liquid Messenger workers`);
  for (let i = 0; i < workers; i += 1) cluster.fork();
  cluster.on('exit', (worker, code, signal) => {
    console.error(`Worker ${worker.process.pid} exited`, { code, signal });
    cluster.fork();
  });
} else {
  require('../backend/gateway/src/server').startServer().catch(error => {
    console.error('Failed to start worker', error);
    process.exit(1);
  });
}
