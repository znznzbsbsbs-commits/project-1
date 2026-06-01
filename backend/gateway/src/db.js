const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://messenger:messenger@localhost:5432/messenger',
  max: Number(process.env.PG_POOL_MAX || 20),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 8000,
});

async function query(text, params = []) {
  const started = Date.now();
  try {
    const result = await pool.query(text, params);
    if (process.env.SQL_DEBUG === 'true') console.log('sql', { text, duration: Date.now() - started, rows: result.rowCount });
    return result;
  } catch (error) {
    error.query = text;
    throw error;
  }
}

async function transaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function runSqlFile(filePath) {
  const sql = fs.readFileSync(path.resolve(filePath), 'utf8');
  await query(sql);
}

module.exports = { pool, query, transaction, runSqlFile };
