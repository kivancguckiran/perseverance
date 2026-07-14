# Tek kiracılı alfa release checklist

WP12 bağımsız kabul edildi ve Faz 1 tamamlandı.

## Release gate

- [x] `pnpm install --frozen-lockfile`
- [x] Protocol generator iki kez; generated drift yok
- [x] `pnpm verify`
- [x] `pnpm alpha:accept`
- [x] Opt-in gerçek hesap/model ile `pnpm alpha:canary`
- [x] `pnpm alpha:lifecycle` temiz install/start/stop/restart, migration ve backup/restore provası
- [x] 1280×720 browser kabulü
- [x] 390×844 browser kabulü
- [x] Browser tab'ları ve dev process'leri kapalı
- [x] 3000/3100 dinleyen kabul süreci yok
- [x] Geçici DB, WAL/SHM, artifact, workspace ve Codex home kalmadı
- [x] `git diff --check`
- [x] WP12 commit'i dışında `git status --short` temiz

## Browser matrisi

Her iki viewport'ta session oluşturma/yakın session navigasyonu, readiness/auth,
timeline reload/reconnect, approval context/sonuç, Git status/diff/log, durable audit,
loading/empty/stale/error durumları kontrol edilir. `document.documentElement.scrollWidth`
viewport genişliğini aşmamalı; console warning/error ve Vite overlay bulunmamalıdır.

## Failure kuralı

Her eksik, atlanan veya ölçülemeyen kontrol release blocker'dır. `alpha:accept` gerçek
canary çalıştırmaz. Canary auth/model erişimi yüzünden çalıştırılamazsa deterministic gate
geçmiş olsa bile sonuç `çalıştırılamadı` olarak raporlanır; başarıya çevrilmez.
