# Deploy ke Railway

Project ini sekarang siap dideploy lewat Dockerfile supaya Playwright Chromium punya dependency Linux yang lengkap.

## Env yang direkomendasikan

Minimal:

```text
HEADLESS=true
FORCE_HEADED_LOGIN=false
MANUAL_PASSWORD=false
SHOW_POINTER=false
BASIC_AUTH_USER=admin
BASIC_AUTH_PASSWORD=ganti-password-kuat
DEFAULT_ACCOUNT_PASSWORD=opsional-jika-semua-akun-pakai-password-sama
```

Kalau ingin data akun, VCC, dan browser profile tetap tersimpan setelah restart atau redeploy:

1. Tambahkan Railway Volume, mount misalnya ke `/data`
2. Set env ini:

```text
DATA_DIR=/data
PERSISTENT_PROFILE=true
PROFILE_DIR=/data/.profiles/duolingo-chromium
```

Kalau tidak pakai volume, biarkan `PERSISTENT_PROFILE=false` atau kosong. Data file dan session browser akan hilang saat container diganti.

## Langkah deploy

### Opsi Git repo

1. Push source code ini ke Git repository.
2. Di Railway, buat service baru dari repo tersebut.
3. Pastikan service memakai `Dockerfile` dari repo.
4. Isi environment variables seperti di atas.
5. Deploy.

### Opsi Railway CLI

1. Install Railway CLI.
2. Login ke Railway.
3. Dari folder project ini jalankan `railway init` atau `railway link`.
4. Set environment variables yang dibutuhkan.
5. Jalankan `railway up`.

Setelah deploy, health check tersedia di `/healthz`.
