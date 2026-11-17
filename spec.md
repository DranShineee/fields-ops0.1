# SPEC.md — FieldsOps

**Service Marketplace & Management Platform (Web-based)**
**Versi:** 1.0.0
**Tipe Aplikasi:** Prototipe Frontend (Single HTML Page / Vite + Vanilla JS)
**Target Rilis:** Latihan 1 Hari

---

## 1. Tujuan
Membangun aplikasi web prototipe untuk katalog layanan dan manajemen produk (Service Marketplace & Management) yang berjalan sepenuhnya di sisi klien (client-side). Aplikasi ini dirancang untuk memfasilitasi calon pembeli dalam melihat ketersediaan produk dan memesan via WhatsApp, serta memberikan dasbor sederhana bagi pengelola toko untuk mengelola inventaris tanpa memerlukan backend atau sistem login yang kompleks.

## 2. Pengguna
Aplikasi ini digunakan dalam satu perangkat (single-device) dengan dua peran utama:
1. **Calon Pembeli (Buyer):** Mengakses halaman Katalog untuk mencari, memfilter, dan memesan produk via WhatsApp.
2. **Pengelola Toko (Admin/Manager):** Mengakses halaman Dashboard untuk menambah, mengubah, menghapus produk, serta mengatur nomor WhatsApp tujuan.

## 3. Daftar Fitur (MVP)
### 3.1. Halaman Katalog (Pembeli)
*   **Tampilan Produk:** Menampilkan grid 8 produk contoh dengan gambar (placeholder lokal/SVG), nama, kategori, harga (Rupiah), dan status stok.
*   **Pencarian (Search):** Mencari produk berdasarkan nama, kategori, atau deskripsi secara *real-time* (debounce).
*   **Filter Kategori:** Menyaring produk berdasarkan kategori (Peralatan, Safety, Suku Cadang, Alat Ukur, Jasa).
*   **Pengurutan (Sorting):** Mengurutkan berdasarkan Unggulan, Nama (A-Z/Z-A), Harga (Terendah/Tertinggi), dan Stok (Terbanyak).
*   **Indikator Filter Aktif:** Menampilkan *chip* filter yang sedang aktif dan dapat dihapus satu per satu.
*   **Tombol Pesan WhatsApp:** Mengarahkan ke `wa.me` dengan *pre-filled text* (nama produk, ID, harga, dan jumlah).
*   **Status Stok:** Tombol pesan otomatis nonaktif (disabled) jika stok habis.

### 3.2. Halaman Dashboard (Pengelola)
*   **Ringkasan Statistik (Stats):** Menampilkan total produk, total stok, jumlah kategori, dan jumlah produk unggulan.
*   **Pengaturan WhatsApp:** Fitur untuk mengubah nomor tujuan WhatsApp secara global. Format `08...` otomatis dinormalisasi menjadi `62...`.
*   **CRUD Produk:**
    *   *Create/Update:* Formulir dengan validasi inline (Nama, Kategori, Harga, Stok, Deskripsi, Unggulan).
    *   *Delete:* Menghapus produk dengan dialog konfirmasi kustom.
    *   *Reset Seed:* Mengembalikan data ke 8 produk contoh awal.
*   **Upload Gambar:** 
    *   Mendukung *drag-and-drop* atau *file picker*.
    *   Kompresi otomatis gambar (maks 3MB, di-resize ke 640px).
    *   Alternatif input via URL eksternal.
*   **Tabel Inventaris:** Daftar semua produk dengan tombol aksi (Edit/Hapus).

### 3.3. Fitur Sistem
*   **Penyimpanan Lokal (LocalStorage):** Menyimpan data produk dan pengaturan nomor WhatsApp secara persisten di browser.
*   **UI/UX:** Desain antarmuka bergaya *enterprise* (terinspirasi Telkom Indonesia), responsif (mobile-friendly), notifikasi *toast*, dan modal kustom.

## 4. Data Model
Aplikasi menggunakan `localStorage` dengan dua *keys* utama:

### 4.1. `fieldsops.products.v1` (Array of Objects)
Menyimpan daftar produk.
```javascript
{
  id: String,          // Format: "P01", "P02" (Auto-increment)
  nama: String,        // Nama produk (min. 3 karakter)
  kategori: String,    // Enum: 'Peralatan', 'Safety', 'Suku Cadang', 'Alat Ukur', 'Jasa'
  harga: Number,       // Angka >= 0 (Rupiah)
  stok: Number,        // Integer >= 0
  deskripsi: String,   // Deskripsi singkat (maks 240 karakter)
  imageUrl: String,    // Berisi Data URL (base64) atau URL http(s)
  unggulan: Boolean    // true/false
}