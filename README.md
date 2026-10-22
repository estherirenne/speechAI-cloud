# SpeechAI — English Speaking Partner (Cloud Services Checkpoint)

Aplikasi latihan ngobrol bahasa Inggris. Pengguna bicara lewat mikrofon (Web Speech API di browser),
backend menyimpan percakapan per pengguna di PostgreSQL, dan balasan AI dibuat oleh Ollama.

## Arsitektur

```
Browser (Chrome)
   │  http://localhost:8080
   ▼
[web]  nginx          ── network: frontend
   │  /api/*, /health  (reverse proxy)
   ▼
[api]  Node/Express   ── network: frontend + backend ──► Ollama di host (host.docker.internal:11434)
   │  SQL (role speechai_app, kena RLS)
   ▼
[db]   PostgreSQL 16  ── network: backend ── volume: pgdata
```

- `web` dan `db` tidak berada di network yang sama; hanya `api` yang menghubungkan keduanya.
- Hanya port `8080` (web) yang dibuka ke host. Database tidak dibuka keluar.
- Ollama sengaja jalan di host (bukan container) karena model besar dan lambat bila CPU-only di Docker Desktop.

## Cara menjalankan

Prasyarat: Docker Desktop, app Ollama (kebuka), dan model sudah di-download.

```bash
ollama pull llama3.2          # sekali saja
cp .env.example .env          # lalu edit .env, ganti semua nilai change_me_*
docker compose up --build -d
docker compose ps             # tunggu sampai semua "healthy"
```

Buka **http://localhost:8080** di Chrome. Akun demo: `alice / alice123` dan `bob / bob123`
(atau klik Register untuk akun baru). Klik **Talk**, bicara, klik **Done**.

Berhenti: `docker compose down` (data tetap ada). Hapus semua data: `docker compose down -v`.

## Fitur dan CRUD

| Operasi | Endpoint | Di UI |
|---|---|---|
| Create | `POST /api/chats`, `POST /api/chats/:id/messages` | New chat / kirim ucapan |
| Read | `GET /api/chats`, `GET /api/chats/:id` | History, isi percakapan |
| Update | `PATCH /api/chats/:id` | tombol ✎ di History |
| Delete | `DELETE /api/chats/:id` | tombol × di History |
| Auth | `POST /api/register`, `POST /api/login` | form login |
| Health | `GET /health` | indikator "Server online" |

## Skema database dan pembatasan akses

Tabel: `users`, `chats` (milik user), `messages` (milik chat). Skema ada di `db/init.sh`.

- API memakai role `speechai_app` (bukan superuser), jadi tidak bisa melewati RLS.
- RLS aktif (ENABLE + FORCE) di `chats` dan `messages`. Policy: `user_id = current_setting('app.user_id')`.
- Tiap request API membuka transaksi dan mengisi `app.user_id` dari token login (`set_config`),
  jadi query seperti `SELECT * FROM chats` otomatis hanya mengembalikan data user itu.
- Policy `messages` juga memastikan pesan hanya bisa ditulis ke chat milik sendiri.
- Password disimpan sebagai hash bcrypt (`pgcrypto`), tidak pernah plaintext.

## Validasi, healthcheck, log

- Validasi: username 3–30 karakter alfanumerik/underscore, password 6–100, pesan 1–2000 karakter,
  judul chat 1–100, id harus UUID, level harus salah satu dari 3 pilihan. Salah → HTTP 400.
- Healthcheck di Compose untuk ketiga layanan; `api` menunggu `db` healthy, `web` menunggu `api` healthy.
- Log API berformat JSON satu baris per kejadian: `docker compose logs -f api`.

## Skenario demo (sesuai ketentuan dosen)

1. **Alur normal**: login sebagai alice → Talk → Done → AI membalas → chat muncul di History.
2. **Container & infrastruktur**: tunjukkan
   ```bash
   docker images | grep speechai        # image yang dibangun
   docker compose ps                    # container, port, status health
   docker volume ls | grep pgdata       # volume penyimpanan
   docker network ls | grep speechai    # network frontend & backend
   docker compose logs api              # log
   ```
3. **Data bertahan setelah container dibuat ulang** (tanpa `-v`):
   ```bash
   docker compose down
   docker compose up -d
   ```
   Login lagi → History masih ada.
4. **Isolasi dua pengguna (RLS)**:
   ```bash
   # ambil token alice dan bob
   A=$(curl -s -X POST localhost:8080/api/login -H 'Content-Type: application/json' -d '{"username":"alice","password":"alice123"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')
   B=$(curl -s -X POST localhost:8080/api/login -H 'Content-Type: application/json' -d '{"username":"bob","password":"bob123"}'   | sed 's/.*"token":"\([^"]*\)".*/\1/')
   curl -s localhost:8080/api/chats -H "Authorization: Bearer $A"     # chat milik alice
   curl -s localhost:8080/api/chats -H "Authorization: Bearer $B"     # chat milik bob
   # pakai id chat alice dengan token bob → 404
   curl -i localhost:8080/api/chats/<ID_CHAT_ALICE> -H "Authorization: Bearer $B"
   ```
   Langsung di database:
   ```bash
   docker compose exec db psql -U speechai_admin -d speechai
   ```
   ```sql
   SET ROLE speechai_app;
   SELECT count(*) FROM chats;                          -- 0 (belum ada user aktif)
   SELECT set_config('app.user_id', '<ID_ALICE>', false);
   SELECT title FROM chats;                             -- hanya chat alice
   ```
   (`SELECT id, username FROM users;` dijalankan sebelum `SET ROLE` untuk mengambil id.)
5. **Input salah**:
   ```bash
   curl -i -X POST localhost:8080/api/chats/<ID_CHAT>/messages \
     -H "Authorization: Bearer $A" -H 'Content-Type: application/json' -d '{"content":"   "}'
   # → 400 Message cannot be empty
   ```
6. **Gangguan layanan + diagnosis + pemulihan**:
   ```bash
   docker compose stop db          # simulasi database mati
   curl -i localhost:8080/health   # 503 {"status":"degraded","db":"down"}; indikator UI jadi merah
   docker compose logs --tail 20 api   # log: "database unavailable"
   docker compose start db         # pulihkan
   docker compose ps               # tunggu db healthy, /health kembali 200
   ```
   Variasi: matikan app Ollama → kirim ucapan → UI menampilkan "AI service is unavailable";
   log API berisi "ollama request failed". Nyalakan lagi Ollama untuk memulihkan.

## Hubungan dengan Week 1–7

| Week | Materi | Di proyek ini |
|---|---|---|
| 1 | Konsep cloud | Rencana deploy ke cloud (di bawah); pemisahan layanan seperti model IaaS/PaaS |
| 2 | Git & Linux | Repo Git, `.gitignore`, `.env` tidak di-commit, perintah Linux/CLI di demo |
| 3–4 | Jaringan/HTTP | REST API, status code (200/201/400/401/404/502/503), reverse proxy nginx, port mapping |
| 5 | Dockerfile | `api/Dockerfile`, `web/Dockerfile`, image `speechai-api`, `speechai-web` |
| 6 | Docker Compose | 3 layanan, 2 network, volume, healthcheck, `depends_on` |
| 7 | Database & kontrol akses | PostgreSQL, role terbatas, RLS, hash password |

## Rencana penggunaan layanan cloud

- Frontend: static hosting/CDN (atau container nginx di layanan container).
- API: layanan container terkelola (mis. Cloud Run / ECS / Azure Container Apps), env dari secret manager.
- Database: PostgreSQL terkelola (mis. Cloud SQL / RDS) dengan backup otomatis, menggantikan volume lokal.
- AI: Ollama lokal diganti API LLM terkelola (cukup ubah `OLLAMA_URL`/kode `askOllama`).
- Jaringan: HTTPS di depan web, database hanya di private network.

## Catatan kontribusi anggota

| Anggota | Bagian | Yang dikerjakan | Bukti (commit/PR) |
|---|---|---|---|
| ESTHER NASYA IRENNE | Frontend | Halaman Sign in/Sign up, alur Talk/Done, kotak edit teks, History, indikator server | https://github.com/estherirenne/speechAI-cloud/commit/c292493 |
| PRISCILLA VALENCIA ANDOW | Backend/API | | |
| MARYAM DINARA AL ADHAWIYYAH BURHANI | Database + Docker/Compose + pengujian | | |

## Troubleshooting

- `docker compose up` bilang variabel kosong → `.env` belum dibuat dari `.env.example`.
- Ubah `db/init.sh` tapi tidak berpengaruh → skrip hanya jalan saat volume baru: `docker compose down -v` lalu `up`.
- "AI service is unavailable" → app Ollama belum jalan, atau model belum di-pull. Di Linux, pastikan Ollama
  bisa diakses dari container (`OLLAMA_HOST=0.0.0.0`).
- Mic tidak jalan → buka lewat `http://localhost:8080` di Chrome (bukan lewat IP).
- Port 8080 bentrok → ubah mapping `8080:80` di `docker-compose.yml`.
