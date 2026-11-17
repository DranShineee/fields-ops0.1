# FieldsOps — Marketplace Jasa Teknisi

Platform pemesanan jasa perbaikan dan pemeliharaan (AC, sepeda motor, komputer,
sepeda) dengan tiga peran: **customer**, **teknisi**, dan **admin**. Dibangun
dengan Express 4 + EJS (server-rendered) + MySQL 8, tanpa framework front-end.

Alur utama:

```
customer pilih layanan → booking (tanggal, jam, alamat) → bayar penuh / COD
   → admin memproses booking & menugaskan teknisi → teknisi menerima
   → work order + bukti pekerjaan → admin memvalidasi
   → komisi & pendapatan teknisi → ulasan customer
```

## Menjalankan

```bash
npm install
cp .env.example .env      # isi kredensial MySQL + SESSION_SECRET
npm run db:reset          # buat tabel + data demo (destruktif)
npm run build             # kompilasi Tailwind ke public/css/app.css
npm start                 # http://localhost:3000
```

| Perintah | Fungsi |
| --- | --- |
| `npm start` | Jalankan server (`PORT`, default 3000) |
| `npm run dev` | Server dengan `--watch` |
| `npm run build` / `npm run css:build` | Kompilasi Tailwind CSS ke `public/css/app.css` |
| `npm run migrate` | Terapkan `db/schema.sql` (idempoten, data lama tetap) |
| `npm run seed` | Isi data demo bila belum ada |
| `npm run db:reset` | Hapus tabel, buat ulang, seed ulang |
| `npm run test:e2e` | Uji E2E alur bisnis + RBAC (server harus berjalan) |
| `npm run test:links` | Crawler tautan internal, laporkan 404/500 |

> `npm run css:build` wajib dijalankan setiap kali kelas Tailwind baru dipakai
> di `views/`. Vercel menjalankannya otomatis lewat `npm run build`.

## Akun demo

| Peran | Email | Kata sandi |
| --- | --- | --- |
| Admin | `admin@fieldsops.id` | `Admin#2026` |
| Customer | `budi@fieldsops.id` | `Pembeli#2026` |
| Customer | `sinta@example.com`, `rizky@example.com` | `Pembeli#2026` |
| Teknisi (disetujui) | `teknisi1@fieldsops.id`, `teknisi2@fieldsops.id` | `Teknisi#2026` |
| Teknisi (menunggu) | `teknisi3@fieldsops.id` | `Teknisi#2026` |
| Teknisi (perlu revisi) | `teknisi4@fieldsops.id` | `Teknisi#2026` |

## Sistem desain

- Tailwind kustom (`tailwind.config.js`) + komponen di `src/styles/tailwind.css`.
- Tipografi editorial: **Space Grotesk** (judul) + **Public Sans** (teks).
- Palet kertas–tinta–tanah liat (`paper`, `ink`, `clay`, `moss`, `amber`), bukan
  gradien ungu-biru generik.
- Layout asimetris: hero dua kolom dengan kartu layanan mengambang, panel admin
  dengan sidebar tetap, tabel bernomor tabular.
- Panah hero transparan tanpa latar putih dan tanpa penghitung slide.
- Semua halaman (publik, customer, teknisi, admin) memakai partial yang sama:
  `partials/head`, `partials/site-header`, `partials/site-footer`, dan
  `partials/panel-start`/`panel-end` untuk panel.
- Animasi menghormati `prefers-reduced-motion`.

## Fitur per peran

**Publik** — beranda, katalog `/layanan` (filter kategori/harga/urut), halaman
kategori, detail layanan (deskripsi, harga, ulasan, teknisi), form booking,
registrasi customer & pendaftaran teknisi.

**Customer** — `/akun` (booking aktif + riwayat), detail booking, unggah bukti
pembayaran, pembatalan booking, ulasan bintang, profil & alamat, ganti kata
sandi, keluhan, notifikasi.

**Teknisi** — `/teknisi`: dasbor, pengajuan kemitraan, profil, kompetensi,
ketersediaan, penugasan (terima/tolak), pekerjaan + unggah bukti, pengajuan
hasil ke admin, riwayat, pendapatan, pengaturan.

**Admin** — `/admin`: dasbor, pengguna, verifikasi teknisi, data teknisi,
kategori, layanan, booking (proses/batal/tugaskan), service order, penugasan,
work order (validasi + hitung komisi), transaksi (verifikasi/tolak/refund),
komisi & aturan persentase, ulasan, keluhan, laporan, audit log, pengaturan.

## Alur pembayaran

- **Bayar penuh** — transfer bank atau QRIS. Customer mengunggah bukti, status
  transaksi menjadi `pending_verification`, admin memverifikasi → `paid`.
- **COD** — dibayar di tempat. Admin memverifikasi transaksi setelah pekerjaan
  selesai (uang diterima) sehingga status menjadi `paid`.
- Refund hanya untuk transaksi `paid` dan wajib menyertakan alasan.

## Alur penugasan, work order, komisi

1. Admin memproses booking → service order `awaiting_assignment`.
2. Admin menugaskan teknisi yang punya kompetensi kategori tersebut →
   assignment `offered`, work order `assigned`.
3. Teknisi menerima/tolak. **Menolak** mengembalikan service order ke
   `awaiting_assignment`, melepas teknisi, dan menghapus work order.
4. Teknisi mulai → unggah bukti → ajukan hasil (`submitted_for_review`).
5. Admin memvalidasi → work order & service order `completed`, komisi platform
   dihitung otomatis dari `commission_rules` (default 15%), pendapatan teknisi =
   bruto − komisi.
6. Customer memberi ulasan bintang 1–5 satu kali per service order.

Pembatalan booking (oleh customer maupun admin) membatalkan service order,
menutup assignment aktif, dan menghapus work order sehingga jadwal teknisi dan
slot tanggal/jam kembali tersedia.

## Keamanan

- Kata sandi bcrypt; sesi MySQL (`express-mysql-session`), cookie `httpOnly`,
  `SameSite=Lax`, `secure` di production.
- CSRF token per sesi untuk semua POST, termasuk multipart (diverifikasi setelah
  multer via `verifyCsrf`).
- RBAC berlapis: `requireRole` (403 untuk peran salah), `requireApprovedTechnician`,
  dan pemeriksaan kepemilikan data per baris (booking, berkas, penugasan).
- Semua query memakai prepared statement (`pool.execute`), input divalidasi dan
  dibatasi panjangnya; EJS meng-escape seluruh output (uji XSS ada di E2E).
- Unggahan dibatasi tipe (JPG/PNG/WebP/PDF) dan ukuran; berkas privat disajikan
  lewat route ber-otorisasi `/berkas/:kind/:name`.
- Login throttle per IP+email, audit log untuk aksi admin.
- Header keamanan: `nosniff`, `SAMEORIGIN`, `Referrer-Policy`, `Permissions-Policy`.

## Deployment ke Vercel

Aplikasi sudah berbentuk serverless: `api/index.js` meneruskan setiap request ke
Express (`src/app.js`), tanpa proses latar/cron, tanpa `listen` di production.

1. **Database**: gunakan MySQL yang dapat diakses dari Vercel (PlanetScale,
   Aiven, Railway, TiDB, atau managed MySQL lain). Jalankan migrasi sekali dari
   mesin lokal:
   ```bash
   DB_HOST=... DB_USER=... DB_PASSWORD=... DB_NAME=... npm run migrate
   ```
   Jangan jalankan `db:reset` pada database produksi.
2. **Environment Variables** (Project → Settings → Environment Variables):
   `NODE_ENV=production`, `SESSION_SECRET` acak ≥32 karakter, `DB_HOST`,
   `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_POOL=2`, dan bila perlu
   `STORAGE_DIR`, `UPLOAD_DIR`, `UPLOAD_MAX_BYTES`. Lihat `.env.example`.
3. **Deploy**: hubungkan repo, biarkan Vercel memakai `vercel.json`
   (`buildCommand: npm run build`, semua route di-rewrite ke `api/index.js`).
4. **Health check**: `GET /health` mengembalikan `{ status: "ok" }`.

### Batasan yang perlu diketahui

- Filesystem Vercel read-only kecuali `/tmp` dan bersifat sementara. Unggahan
  lokal (KTP, bukti bayar, bukti pekerjaan) **hilang** saat instance berhenti.
  Untuk produksi, arahkan `STORAGE_DIR` ke `/tmp` agar tidak error, lalu
  migrasikan penyimpanan ke object storage (S3/R2) di `src/routes/files.js` dan
  `src/utils/uploads.js`.
- Pool koneksi dibatasi kecil (`DB_POOL=2`) karena setiap instance serverless
  punya pool sendiri; sesuaikan dengan batas koneksi penyedia database.
- Tidak ada background worker: notifikasi bersifat in-app (tabel `notifications`),
  bukan email/push.

## Struktur

```
api/index.js         Entry point serverless Vercel
src/app.js           Konfigurasi Express (middleware, route, error handler)
src/server.js        Hanya listen lokal + graceful shutdown
src/db.js            mysql2/promise pool + helper query/transaction
src/routes/          auth, files, catalog, customer, technician, admin
src/middleware/      auth/RBAC, CSRF, view locals, error handling
src/utils/           format, bookings, uploads, audit, notify, pagination
src/styles/tailwind.css  Sumber design system (dikompilasi ke public/css/app.css)
views/               EJS per area (auth, booking, customer, teknisi, admin, partials)
scripts/e2e.mjs      Uji E2E alur bisnis + RBAC
scripts/links.mjs    Crawler tautan internal (404/500)
db/schema.sql        Skema MySQL lengkap
db/migrate.js        Migrasi + seed demo
vercel.json          Konfigurasi deployment
```

## Catatan teknis

- `db/migrate.js` mengabaikan komentar SQL sebelum memecah statement per `;`.
- Rahasia hanya di `.env` (gitignored); jangan commit kredensial database.
