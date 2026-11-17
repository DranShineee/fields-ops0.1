/**
 * Crawler tautan internal: menjelajah semua halaman publik, customer, teknisi,
 * dan admin lalu melaporkan URL yang 404/500.
 *
 *   BASE=http://localhost:3000 node scripts/links.mjs
 */
const BASE = process.env.BASE || 'http://localhost:3000';

class Session {
  constructor(name) {
    this.name = name;
    this.cookies = new Map();
  }
  store(response) {
    for (const raw of response.headers.getSetCookie?.() || []) {
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      if (!i) continue;
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
  }
  async get(path) {
    const response = await fetch(`${BASE}${path}`, {
      headers: this.cookies.size ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {},
      redirect: 'manual',
    });
    this.store(response);
    return { status: response.status, location: response.headers.get('location'), text: await response.text() };
  }
  async login(email, password) {
    const page = await this.get('/login');
    const token = page.text.match(/name="_csrf" value="([^"]+)"/)?.[1] || '';
    const response = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: new URLSearchParams({ _csrf: token, email, password }),
      redirect: 'manual',
    });
    this.store(response);
    return response.status;
  }
}

const SKIP = /\/(logout|health|uploads|berkas)\b/;

async function crawl(session, seeds, seen, problems, limit = 250) {
  const queue = [...seeds];
  while (queue.length && seen.size < limit) {
    const path = queue.shift();
    if (seen.has(path) || SKIP.test(path)) continue;
    seen.add(path);
    const result = await session.get(path);
    if (result.status === 404 || result.status >= 500) problems.push([session.name, path, result.status]);
    if (result.status !== 200) continue;
    for (const match of result.text.matchAll(/href="(\/[^"#]*)"/g)) {
      const href = match[1].split('?')[0];
      if (href && !SKIP.test(href) && !seen.has(href)) queue.push(href);
    }
  }
}

const sessions = [
  ['publik', null],
  ['customer', ['budi@fieldsops.id', 'Pembeli#2026']],
  ['teknisi', ['teknisi1@fieldsops.id', 'Teknisi#2026']],
  ['admin', ['admin@fieldsops.id', 'Admin#2026']],
];

const problems = [];
const allUrls = new Set();

for (const [name, credentials] of sessions) {
  const session = new Session(name);
  if (credentials) {
    const status = await session.login(...credentials);
    console.log(`${name}: login ${status}`);
  }
  const seen = new Set();
  const seeds = ['/', '/layanan', '/kategori', '/login', '/register'];
  if (name === 'customer') seeds.push('/akun', '/profil', '/keluhan', '/notifikasi');
  if (name === 'teknisi') seeds.push('/teknisi', '/teknisi/penugasan', '/teknisi/pekerjaan', '/teknisi/riwayat', '/teknisi/pendapatan');
  if (name === 'admin') seeds.push('/admin', '/admin/booking', '/admin/transaksi', '/admin/laporan');
  await crawl(session, seeds, seen, problems);
  for (const url of seen) allUrls.add(url);
  console.log(`${name}: ${seen.size} halaman diperiksa`);
}

console.log(`\nTotal ${allUrls.size} URL unik.`);
if (problems.length) {
  console.log('MASALAH:');
  for (const [role, path, status] of problems) console.log(`  ${status} ${path} (${role})`);
  process.exit(1);
}
console.log('Tidak ada tautan 404/500.');
