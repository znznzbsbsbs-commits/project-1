const bcrypt = require('bcryptjs');
const { transaction, pool } = require('./db');
async function main() {
  const users = [
    ['alexey','alexey@example.com','Алексей','admin'],
    ['maria','maria@example.com','Мария','user'],
    ['design','design@example.com','Design Lead','user']
  ];
  await transaction(async c => {
    for (const [username,email,name,role] of users) {
      const hash = await bcrypt.hash('Password123!', 10);
      const u = await c.query('INSERT INTO users(username,email,password_hash,role,email_verified) VALUES($1,$2,$3,$4,true) ON CONFLICT(username) DO UPDATE SET email=EXCLUDED.email RETURNING *', [username,email,hash,role]);
      await c.query('INSERT INTO profiles(user_id,display_name,bio) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET display_name=EXCLUDED.display_name', [u.rows[0].id,name,'Seed user']);
    }
    const a = await c.query("SELECT id FROM users WHERE username='alexey'");
    const m = await c.query("SELECT id FROM users WHERE username='maria'");
    const ch = await c.query("INSERT INTO chats(type,title,description,owner_id) VALUES('private','Мария','Стартовый личный чат',$1) RETURNING *", [a.rows[0].id]);
    await c.query("INSERT INTO chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member') ON CONFLICT DO NOTHING", [ch.rows[0].id,a.rows[0].id,m.rows[0].id]);
    await c.query('INSERT INTO messages(chat_id,sender_id,body) VALUES($1,$2,$3),($1,$4,$5),($1,$2,$6)', [ch.rows[0].id,m.rows[0].id,'Привет',a.rows[0].id,'Теперь интерфейс выглядит объёмнее.','Есть тени, стекло и лёгкий 3D.']);
  });
  console.log('Seed data ready. Users password: Password123!');
}
if (require.main === module) main().finally(() => pool.end());
module.exports = main;
