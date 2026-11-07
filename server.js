process.env.TZ = process.env.TZ || 'Asia/Makassar';
const os = require('os'), http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const PORT = process.env.PORT || 3000, PASS = process.env.ADMIN_PASSWORD || 'admin123', SHOP = process.env.SHOP_NAME || 'Toko Aksesoris';
const db = new DatabaseSync(path.join(__dirname, 'toko.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS categories(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER, name TEXT, price INTEGER, description TEXT DEFAULT '', available INTEGER DEFAULT 1, ver INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS photos(product_id INTEGER PRIMARY KEY, data TEXT);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, customer TEXT, phone TEXT, address TEXT, items TEXT, total INTEGER, note TEXT, status TEXT, method TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS transactions(id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, amount INTEGER, note TEXT, created_at INTEGER, order_id INTEGER);
CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER UNIQUE, customer TEXT, rating INTEGER, comment TEXT DEFAULT '', created_at INTEGER);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);`);
try { db.exec('ALTER TABLE orders ADD COLUMN fulfil TEXT'); } catch {}
const all = (s, ...a) => db.prepare(s).all(...a), get = (s, ...a) => db.prepare(s).get(...a), run = (s, ...a) => db.prepare(s).run(...a);
if (!get('SELECT id FROM categories')) for (const c of ['Gelang', 'Kalung', 'Cincin', 'Anting']) run('INSERT INTO categories(name) VALUES(?)', c);
const setting = k => get('SELECT value FROM settings WHERE key=?', k)?.value;
const setS = (k, v) => run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, v);
const bump = () => setS('v', String(Date.now()));
const IMG = /^data:image\/(png|jpe?g|webp);base64,/, IMGK = ['logo', 'banner', 'qris'];
const dayKey = ts => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const FUL = { antar: 'Antar', ambil: 'Ambil', cod: 'COD' };
const addIn = o => run("INSERT INTO transactions(type,amount,note,created_at,order_id) VALUES('in',?,?,?,?)", o.total, `Pesanan #${o.id} - ${o.customer} (${o.method === 'cash' ? 'Tunai' : 'QRIS'}, ${FUL[o.fulfil || 'antar']})`, Date.now(), o.id);
const h = s => crypto.createHash('sha256').update(String(s)).digest();
const lanIP = () => { for (const l of Object.values(os.networkInterfaces())) for (const i of l || []) if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254')) return i.address; };
const err = (status, error, extra) => Object.assign(new Error(error), { status, extra });
const sessions = new Set(), routes = [], fails = {};
const R = (m, p, fn, admin) => routes.push({ m, admin, fn, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$') });
const parseItems = o => ({ ...o, items: JSON.parse(o.items) });
const pub = o => ({ code: o.code, fulfil: o.fulfil || 'antar', items: JSON.parse(o.items), total: o.total, status: o.status, method: o.method, reviewed: !!get('SELECT id FROM reviews WHERE order_id=?', o.id) });
const checkStock = items => items.map(i => get('SELECT id,name,available FROM products WHERE id=?', i.id)).filter(m => !m || !m.available).map(m => m ? m.name : 'Produk dihapus');
const savePhoto = (id, ph) => {
  if (ph == null) return;
  if (ph === '') { run('DELETE FROM photos WHERE product_id=?', id); run('UPDATE products SET ver=0 WHERE id=?', id); return; }
  if (!IMG.test(ph)) throw err(400, 'Foto harus berupa gambar');
  run('INSERT INTO photos(product_id,data) VALUES(?,?) ON CONFLICT(product_id) DO UPDATE SET data=excluded.data', id, ph);
  run('UPDATE products SET ver=? WHERE id=?', Date.now(), id);
};

// ---------- PUBLIK ----------
R('GET', '/api/shop', () => ({
  name: setting('name') || SHOP, pickup: setting('pickup') || '', wa: setting('wa') || '', tagline: setting('tagline') ?? 'Aksesoris cantik untuk harimu', v: setting('v') || '0',
  logo: !!setting('logo'), banner: !!setting('banner'), qris: !!setting('qris'),
  categories: all('SELECT * FROM categories ORDER BY id'),
  items: all('SELECT id,category_id,name,price,description,available,ver FROM products ORDER BY id DESC')
}));
R('GET', '/api/img/:k', c => {
  const k = c.p.k, d = /^p\d+$/.test(k) ? get('SELECT data FROM photos WHERE product_id=?', +k.slice(1))?.data : IMGK.includes(k) ? setting(k) : null;
  if (!d) throw err(404, 'Gambar tidak ada');
  return { raw: Buffer.from(d.slice(d.indexOf(',') + 1), 'base64'), type: d.slice(5, d.indexOf(';')), cache: 'public, max-age=31536000, immutable' };
});
R('POST', '/api/order', c => {
  const b = c.body, customer = String(b.customer || '').trim().slice(0, 60), phone = String(b.phone || '').replace(/[^\d+]/g, '').slice(0, 20), fulfil = ['antar', 'ambil', 'cod'].includes(b.fulfil) ? b.fulfil : 'antar', address = fulfil === 'ambil' ? '' : String(b.address || '').trim().slice(0, 300);
  if (!customer || phone.length < 8 || (fulfil !== 'ambil' && !address)) throw err(400, fulfil === 'cod' ? 'Lengkapi nama, nomor WhatsApp, dan alamat/titik ketemu COD' : 'Lengkapi nama, nomor WhatsApp, dan alamat');
  const list = (b.items || []).filter(i => i.qty > 0).slice(0, 60); if (!list.length) throw err(400, 'Keranjang kosong');
  const out = checkStock(list); if (out.length) throw err(409, 'Stok habis: ' + out.join(', '), { soldOut: out });
  const items = list.map(i => { const m = get('SELECT * FROM products WHERE id=?', i.id); return { id: m.id, name: m.name, price: m.price, qty: Math.min(99, Math.floor(i.qty)) }; });
  const total = items.reduce((s, i) => s + i.price * i.qty, 0), code = crypto.randomBytes(8).toString('hex');
  run('INSERT INTO orders(code,customer,phone,address,items,total,note,status,created_at,fulfil) VALUES(?,?,?,?,?,?,?,?,?,?)', code, customer, phone, address, JSON.stringify(items), total, String(b.note || '').slice(0, 200), 'unpaid', Date.now(), fulfil);
  return pub(get('SELECT * FROM orders WHERE code=?', code));
});
R('GET', '/api/order/:code', c => { const o = get('SELECT * FROM orders WHERE code=?', c.p.code); if (!o) throw err(404, 'Pesanan tidak ada'); return pub(o); });
R('POST', '/api/order/:code/pay', c => {
  const o = get('SELECT * FROM orders WHERE code=?', c.p.code); if (!o) throw err(404, 'Pesanan tidak ada');
  if (o.status !== 'unpaid') return pub(o);
  const out = checkStock(JSON.parse(o.items));
  if (out.length) { run("UPDATE orders SET status='cancelled' WHERE id=?", o.id); throw err(409, 'Maaf, stok habis: ' + out.join(', ') + '. Pesanan dibatalkan, belum ada pembayaran yang diproses.', { soldOut: out }); }
  const m = c.body.method === 'qris' ? 'qris' : 'cash', fu = o.fulfil || 'antar', hasQ = !!setting('qris');
  if (m === 'qris' && (fu === 'cod' || !hasQ)) throw err(400, 'QRIS tidak tersedia untuk pesanan ini');
  if (m === 'cash' && fu === 'antar' && hasQ) throw err(400, 'Pesanan antar ke rumah dibayar lewat QRIS');
  run("UPDATE orders SET status='waiting',method=? WHERE id=?", m, o.id); return pub(get('SELECT * FROM orders WHERE id=?', o.id));
});

R('GET', '/api/reviews', () => {
  const st = get('SELECT COUNT(*) n, AVG(rating) a FROM reviews');
  return { count: st.n, avg: st.n ? Math.round(st.a * 10) / 10 : 0,
    list: all('SELECT customer,rating,comment,created_at FROM reviews ORDER BY id DESC LIMIT 50').map(r => ({ name: String(r.customer).trim().split(/\s+/)[0], rating: r.rating, comment: r.comment, at: r.created_at })) };
});
R('POST', '/api/order/:code/review', c => {
  const o = get('SELECT * FROM orders WHERE code=?', c.p.code); if (!o) throw err(404, 'Pesanan tidak ada');
  if (o.status !== 'done') throw err(400, 'Ulasan bisa ditulis setelah pesanan selesai');
  const rating = Math.round(+c.body.rating); if (!(rating >= 1 && rating <= 5)) throw err(400, 'Pilih bintang 1 sampai 5');
  if (get('SELECT id FROM reviews WHERE order_id=?', o.id)) throw err(409, 'Kamu sudah memberi ulasan untuk pesanan ini');
  run('INSERT INTO reviews(order_id,customer,rating,comment,created_at) VALUES(?,?,?,?,?)', o.id, o.customer, rating, String(c.body.comment || '').trim().slice(0, 300), Date.now());
  return pub(o);
});

// ---------- ADMIN ----------
R('POST', '/api/login', c => {
  const ip = c.req.socket.remoteAddress, f = fails[ip] || { n: 0, t: 0 }; if (Date.now() - f.t > 6e5) f.n = 0;
  if (f.n >= 5) throw err(429, 'Terlalu banyak percobaan. Coba lagi 10 menit lagi');
  if (!crypto.timingSafeEqual(h(c.body.password), h(PASS))) { f.n++; f.t = Date.now(); fails[ip] = f; throw err(401, 'Password salah'); }
  delete fails[ip]; const t = crypto.randomBytes(24).toString('hex'); sessions.add(t); c.setCookie = t; return { ok: true };
});
R('POST', '/api/logout', c => { sessions.delete(c.sid); c.setCookie = ''; return { ok: true }; });
R('GET', '/api/admin/me', () => ({ ok: true }), 1);
R('GET', '/api/admin/orders', () => all("SELECT * FROM orders WHERE status!='unpaid' ORDER BY id DESC LIMIT 100").map(o => { o = parseItems(o); o.soldOut = checkStock(o.items); return o; }), 1);
R('POST', '/api/admin/orders/:id/:action', c => {
  const o = get('SELECT * FROM orders WHERE id=?', +c.p.id); if (!o) throw err(404, 'Pesanan tidak ada');
  if (c.p.action === 'confirm' && o.status === 'waiting') { run("UPDATE orders SET status='paid' WHERE id=?", o.id); if (o.method !== 'cash') addIn(o); }
  else if (c.p.action === 'done' && o.status === 'paid') { run("UPDATE orders SET status='done' WHERE id=?", o.id); if (o.method === 'cash') addIn(o); }
  else if (c.p.action === 'cancel') { run("UPDATE orders SET status='cancelled' WHERE id=?", o.id); run('DELETE FROM transactions WHERE order_id=?', o.id); }
  return { ok: true };
}, 1);
R('GET', '/api/admin/transactions', () => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 4); return all('SELECT * FROM orders WHERE created_at>=? ORDER BY id DESC', d.getTime()).map(parseItems); }, 1);
R('GET', '/api/admin/finance', () => { const days = {};
  for (let i = 0; i < 5; i++) { const d = new Date(); d.setDate(d.getDate() - i); days[dayKey(d)] = { date: dayKey(d), income: 0, expense: 0, tx: [] }; }
  for (const t of all('SELECT * FROM transactions ORDER BY id DESC')) { const x = days[dayKey(t.created_at)]; if (!x) continue; x[t.type === 'in' ? 'income' : 'expense'] += t.amount; x.tx.push(t); }
  const p = get("SELECT COUNT(*) n, COALESCE(SUM(total),0) total FROM orders WHERE status='waiting' OR (status='paid' AND method='cash')");
  return { days: Object.values(days), pending: p }; }, 1);
R('GET', '/api/admin/reviews', () => all('SELECT r.id,r.order_id,r.customer,r.rating,r.comment,r.created_at,o.items FROM reviews r LEFT JOIN orders o ON o.id=r.order_id ORDER BY r.id DESC LIMIT 200').map(r => ({ ...r, items: r.items ? JSON.parse(r.items) : [] })), 1);
R('DELETE', '/api/admin/reviews/:id', c => { run('DELETE FROM reviews WHERE id=?', +c.p.id); return { ok: true }; }, 1);
R('POST', '/api/admin/expense', c => { if (!(+c.body.amount > 0)) throw err(400, 'Jumlah tidak valid');
  run("INSERT INTO transactions(type,amount,note,created_at) VALUES('out',?,?,?)", Math.round(+c.body.amount), String(c.body.note || 'Pengeluaran').trim().slice(0, 100), Date.now()); return { ok: true }; }, 1);
R('DELETE', '/api/admin/tx/:id', c => { run("DELETE FROM transactions WHERE id=? AND type='out'", +c.p.id); return { ok: true }; }, 1);
R('POST', '/api/admin/categories', c => { if (!String(c.body.name || '').trim()) throw err(400, 'Nama kategori kosong'); run('INSERT INTO categories(name) VALUES(?)', c.body.name.trim().slice(0, 40)); return { ok: true }; }, 1);
R('DELETE', '/api/admin/categories/:id', c => {
  run('DELETE FROM photos WHERE product_id IN (SELECT id FROM products WHERE category_id=?)', +c.p.id);
  run('DELETE FROM products WHERE category_id=?', +c.p.id); run('DELETE FROM categories WHERE id=?', +c.p.id); return { ok: true };
}, 1);
R('POST', '/api/admin/products', c => {
  const b = c.body; if (!b.name?.trim() || !(+b.price >= 0) || !b.category_id) throw err(400, 'Nama, harga, dan kategori wajib diisi');
  if (b.photo && !IMG.test(b.photo)) throw err(400, 'Foto harus berupa gambar');
  const id = run('INSERT INTO products(category_id,name,price,description) VALUES(?,?,?,?)', +b.category_id, b.name.trim().slice(0, 80), Math.round(+b.price), String(b.description || '').slice(0, 300)).lastInsertRowid;
  savePhoto(id, b.photo); return { ok: true };
}, 1);
R('PUT', '/api/admin/products/:id', c => {
  const b = c.body, m = get('SELECT * FROM products WHERE id=?', +c.p.id); if (!m) throw err(404, 'Produk tidak ada');
  if (b.photo && !IMG.test(b.photo)) throw err(400, 'Foto harus berupa gambar');
  run('UPDATE products SET name=?,price=?,description=?,category_id=? WHERE id=?', b.name?.trim().slice(0, 80) || m.name, b.price >= 0 ? Math.round(+b.price) : m.price, String(b.description ?? m.description).slice(0, 300), +b.category_id || m.category_id, m.id);
  savePhoto(m.id, b.photo); return { ok: true };
}, 1);
R('POST', '/api/admin/products/:id/toggle', c => { run('UPDATE products SET available=1-available WHERE id=?', +c.p.id); return { ok: true }; }, 1);
R('DELETE', '/api/admin/products/:id', c => { run('DELETE FROM photos WHERE product_id=?', +c.p.id); run('DELETE FROM products WHERE id=?', +c.p.id); return { ok: true }; }, 1);
R('PUT', '/api/admin/setting/:k', c => {
  const k = c.p.k, v = c.body.value;
  if (k === 'wa') { let n = String(v || '').replace(/\D/g, ''); if (n.startsWith('0')) n = '62' + n.slice(1); else if (n.startsWith('8')) n = '62' + n; if ((n || String(v || '').trim()) && (n.length < 9 || n.length > 15)) throw err(400, 'Nomor WhatsApp admin tidak valid'); setS('wa', n); }
  else if (k === 'name' || k === 'tagline' || k === 'pickup') setS(k, String(v || '').trim().slice(0, k === 'pickup' ? 160 : 80));
  else if (IMGK.includes(k)) { if (!IMG.test(v || '')) throw err(400, 'File harus berupa gambar'); setS(k, v); }
  else throw err(404, 'Pengaturan tidak ada');
  bump(); return { ok: true };
}, 1);
R('DELETE', '/api/admin/setting/:k', c => { if (!IMGK.includes(c.p.k)) throw err(404, 'Pengaturan tidak ada'); run('DELETE FROM settings WHERE key=?', c.p.k); bump(); return { ok: true }; }, 1);

// ---------- SERVER ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x'), p = url.pathname;
    const sid = (req.headers.cookie || '').match(/sid=([a-f0-9]+)/)?.[1];
    const send = (code, body, type = 'text/html; charset=utf-8', hd = {}) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...hd }); res.end(body); };
    if (!p.startsWith('/api/')) {
      const f = { '/': 'customer.html', '/admin': 'admin.html', '/style.css': 'style.css', '/sfx.js': 'sfx.js', '/bgm.js': 'bgm.js' }[p];
      const fp = f && path.join(__dirname, 'public', f); if (!fp || !fs.existsSync(fp)) return send(404, 'Halaman tidak ditemukan');
      return send(200, fs.readFileSync(fp), MIME[path.extname(fp)]);
    }
    let body = {}; if (req.method !== 'GET' && req.method !== 'DELETE') { let s = '', n = 0; for await (const ch of req) { n += ch.length; if (n > 8e6) throw err(413, 'File terlalu besar'); s += ch; } try { body = JSON.parse(s || '{}'); } catch { throw err(400, 'JSON tidak valid'); } }
    for (const r of routes) {
      if (r.m !== req.method) continue; const m = p.match(r.re); if (!m) continue;
      if (r.admin && !sessions.has(sid)) throw err(401, 'Belum login');
      const c = { req, body, p: m.groups || {}, sid }, out = r.fn(c), hd = {};
      if (c.setCookie !== undefined) hd['Set-Cookie'] = `sid=${c.setCookie}; Path=/; HttpOnly; SameSite=Lax${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}${c.setCookie ? '' : '; Max-Age=0'}`;
      if (out?.cache) hd['Cache-Control'] = out.cache;
      return out?.raw ? send(200, out.raw, out.type, hd) : send(200, JSON.stringify(out), 'application/json', hd);
    }
    throw err(404, 'API tidak ada');
  } catch (e) { res.writeHead(e.status || 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.status ? e.message : 'Server error', ...e.extra })); if (!e.status) console.error(e); }
}).listen(PORT, () => console.log(`\n♡ Toko berjalan\n   Pelanggan: http://localhost:${PORT}\n   Admin    : http://localhost:${PORT}/admin  (password: ${PASS})\n   Alamat HP (satu WiFi): http://${lanIP() || 'IP-laptop'}:${PORT}\n`));