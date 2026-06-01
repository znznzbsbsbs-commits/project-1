const path = require('path');
const { runSqlFile, pool } = require('./db');

async function main() {
  await runSqlFile(path.join(__dirname, '../../../database/migrations/001_init.sql'));
  console.log('Migrations applied');
}

if (require.main === module) main().finally(() => pool.end());
module.exports = main;
