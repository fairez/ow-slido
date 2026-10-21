# Deploy ke Railway

Aplikasi ini satu service Node (Next.js + Socket.IO dalam satu proses) ditambah satu database PostgreSQL. `railway.json` di root repo sudah mengatur build, migrasi database, health check, dan jumlah replika.

## Langkah

1. Di Railway: **New Project → Deploy from GitHub repo**, pilih `fairez/ow-slido`, branch `main`.
2. Di project yang sama: **New → Database → Add PostgreSQL**.
3. Buka service aplikasi → **Variables**, isi variabel di bawah.
4. Buka **Settings → Networking → Generate Domain** untuk mendapat URL publik (HTTPS otomatis).
5. Deploy. Urutannya: build (`npm run build`) → start dengan `npm run db:migrate && npm start` (migrasi jalan dulu di container yang sama, lalu aplikasi menyala) → health check `/api/health`. Tidak perlu build command khusus; `npm run build` sudah dipakai otomatis.
6. Buka URL-nya, daftar sebagai admin pertama di `/signup`, lalu **tutup pendaftaran** (lihat `ALLOW_SIGNUP` di bawah).

## Variabel

| Variabel | Isi | Wajib |
| --- | --- | --- |
| `DATABASE_URL` | Referensi ke Postgres: `${{Postgres.DATABASE_URL}}` (ganti `Postgres` dengan nama service database Anda). Pakai URL internal supaya tidak lewat internet. | Ya |
| `SESSION_SECRET` | Acak panjang. Buat dengan `openssl rand -hex 32`. Mengganti nilainya membuat semua admin logout. | Ya |
| `PARTICIPANT_TOKEN_SECRET` | Acak panjang lain (jangan sama dengan di atas). Mengganti nilainya membuat peserta harus join ulang. | Ya |
| `ALLOW_SIGNUP` | Isi `false` setelah admin pertama dibuat. Tanpa ini **siapa pun yang membuka URL bisa mendaftar sebagai admin** dan memakai key AI Anda. | Sangat disarankan |
| `AI_PROVIDER` | `openai` atau `openrouter`. Kosongkan untuk mematikan fitur AI. **Jangan** isi `mock` di produksi. | Untuk AI |
| `OPENAI_API_KEY` / `OPENROUTER_API_KEY` | Key sesuai provider. Hanya di Railway Variables, jangan di repo. | Untuk AI |
| `AI_MODEL` | Contoh `gpt-4o-mini`. Kosong memakai default provider. | Tidak |
| `AI_EVENT_CALL_CAP`, `AI_DAILY_CALL_CAP` | Batas panggilan AI per event (default 20) dan total per hari UTC untuk seluruh platform (default 200). Ini batas biaya Anda. | Tidak |
| `AI_GLOBAL_DAILY_CAP` | Batas keras panggilan AI per hari UTC untuk semua workspace (default 1000; `0` mematikan AI). Setelah tercapai, setiap analisis dijawab 503 `ai_paused`. Selama `AI_DAILY_CALL_CAP` lebih kecil, batas itu yang tercapai lebih dulu. | Disarankan |
| `EMAIL_PROVIDER` | `smtp` untuk mengirim email sungguhan. Kosong atau `log` hanya menyimpan email di memori: tautan verifikasi, undangan, dan reset password tidak pernah sampai ke siapa pun. | Ya |
| `EMAIL_FROM` | Alamat pengirim, contoh `OW Slido <no-reply@domain-anda>`. | Dengan `smtp` |
| `SMTP_HOST`, `SMTP_PORT` | Server SMTP. Port default 587; 465 memakai TLS. | `SMTP_HOST` wajib dengan `smtp` |
| `SMTP_USER`, `SMTP_PASSWORD` | Login SMTP, hanya jika server memintanya. | Tergantung server |
| `BILLING_PROVIDER` | `stripe` untuk pembayaran sungguhan, `mock` untuk demo. Tanpa nilai di produksi, rute billing menjawab 503 dan tidak ada paket yang bisa dibeli. | Ya |
| `BILLING_WEBHOOK_SECRET` | Hanya untuk `mock` di produksi: menandatangani event-nya. Acak panjang. | Dengan `mock` |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Key API Stripe dan signing secret endpoint webhook. Langkah lengkap di `docs/billing.md`. | Dengan `stripe` |
| `STRIPE_PRICE_PRO_MONTH`, `STRIPE_PRICE_PRO_YEAR`, `STRIPE_PRICE_TEAM_MONTH`, `STRIPE_PRICE_TEAM_YEAR` | Id harga Stripe untuk tiap paket dan periode. | Dengan `stripe` |
| `TWOFA_ENCRYPTION_KEY` | Kunci 32 byte (64 karakter hex atau base64, `openssl rand -hex 32`) untuk mengenkripsi rahasia 2FA. Tanpa ini tidak ada yang bisa mengaktifkan 2FA. Mengganti nilainya membatalkan semua rahasia dan kode pemulihan 2FA. | Ya |
| `OPERATOR_EMAILS` | Email operator platform, dipisah koma, yang boleh membuka `/ops`. Akunnya juga harus sudah terverifikasi emailnya. Tanpa nilai tidak ada operator. | Untuk operator |
| `JOB_RETRY_BACKOFF_MS` | Jeda (ms) sebelum percobaan ulang 1, 2, dan 3 untuk job latar belakang yang gagal. Default `1000,5000,20000`. | Tidak |
| `QUIZ_GRACE_MS` | Berapa ms jawaban kuis boleh terlambat setelah batas waktu dan tetap dihitung. Default 300. | Tidak |

Jangan isi `TEST_DATABASE_URL`, `ALLOWED_DEV_ORIGINS`, `EMAIL_OUTBOX_FILE`, atau `PORT` (Railway mengisi `PORT` sendiri). Isi nilai rahasia hanya di Railway Variables, bukan di repo atau dokumen ini.

Untuk Stripe, daftarkan endpoint webhook di `https://<domain>/api/billing/webhook` (event dan langkahnya ada di `docs/billing.md`). Daftar yang harus beres sebelum dipakai publik ada di `docs/launch-checklist.md`.

## Yang perlu diketahui

- **Satu replika saja.** Rate limiting dan pesan realtime (Socket.IO) disimpan di memori proses. Dengan dua replika, peserta dan presenter bisa berada di server berbeda dan tidak saling melihat. `railway.json` sudah mengatur `numReplicas: 1`; jangan dinaikkan sebelum ada adapter Redis.
- **Restart memutus koneksi realtime sesaat.** Klien tersambung ulang otomatis dan mengambil data terbaru. Hindari deploy saat acara berlangsung.
- **Migrasi berjalan otomatis** di awal start command, jadi tidak bergantung pada fitur pre-deploy Railway. Log deploy menampilkan `migrated DATABASE_URL: N applied now, M in total`. Jika migrasi gagal, proses berhenti, health check tidak lolos, dan versi lama tetap jalan. Migrasi bersifat idempoten: aman dijalankan berulang.
- **Backup database:** aktifkan backup di service Postgres (tab Backups) sebelum dipakai untuk acara sungguhan.
- **Biaya AI:** tiap admin yang login bisa menekan Analyze notes dan memakai key Anda. Tutup pendaftaran (`ALLOW_SIGNUP=false`) dan pasang `AI_DAILY_CALL_CAP` sesuai anggaran.
- **Kesehatan:** `GET /api/health` mengembalikan 200 jika database terjangkau dan semua migrasi terpasang. 503 berarti `database unavailable` atau `migrations pending` (beserta jumlah terpasang dan yang diharapkan). Jawaban 200 juga memuat `dailyJobs` (kapan job harian `subscriptions` dan `retention` terakhir jalan, dan hasilnya) serta `jobRunner` (antrean, job yang gagal dalam 24 jam, dan job yang macet untuk ekspor dan analisis). Isinya hanya angka, waktu, dan kelas error; tidak ada nilai konfigurasi atau isi data.
- **Domain sendiri:** tambahkan di Settings → Networking → Custom Domain. Cookie login otomatis memakai `Secure` karena Railway meneruskan `x-forwarded-proto: https`.

## Memeriksa setelah deploy

1. `https://<domain>/api/health` menampilkan `"status":"ok"`.
2. Daftar, buat event, mulai satu poll, lalu buka halaman join dari ponsel (data seluler, bukan Wi-Fi yang sama) dan kirim satu suara. Hasilnya harus muncul di halaman presenter.
3. Jika AI dipakai: jalankan Analyze notes sekali pada event uji, dan cek tagihan provider.
4. Set `ALLOW_SIGNUP=false`, redeploy, dan pastikan `/signup` menolak pendaftaran baru.
5. Jika `EMAIL_PROVIDER=smtp`: daftar dengan email uji dan pastikan email verifikasi sampai.

## Jika migrasi tidak jalan

Buka **Deployments → deploy terbaru → Deploy Logs** dan cari baris `migrated DATABASE_URL`.

| Gejala di log | Penyebab dan perbaikan |
| --- | --- |
| Tidak ada baris `migrated` sama sekali | Start command di dashboard menimpa `railway.json`. Buka Settings → Deploy → Custom Start Command dan kosongkan, atau isi `npm run db:migrate && npm start`. |
| `DATABASE_URL is not set` | Variabel belum ada di **service aplikasi**. Tambahkan `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (nama service database harus persis sama). |
| `ENOTFOUND postgres.railway.internal` / `ECONNREFUSED` | Service aplikasi dan database harus ada di project dan environment yang sama. Coba URL publik (`DATABASE_PUBLIC_URL`) hanya untuk uji. |
| `/api/health` menjawab `migrations pending` | Migrasi belum selesai atau gagal. Lihat log, perbaiki, lalu redeploy. |
| `relation "users" does not exist` di log aplikasi | Database belum termigrasi. Sama seperti di atas. |

Untuk menjalankan migrasi manual dari komputer Anda: `railway run npm run db:migrate` (Railway CLI, terhubung ke service aplikasi).
