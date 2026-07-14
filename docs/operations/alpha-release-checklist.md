# Tek kiracılı alfa release checklist

WP12 bağımsız kabul edilmeden Faz 1 tamamlandı sayılmaz.

## Release gate

- [ ] `pnpm install --frozen-lockfile`
- [ ] Protocol generator iki kez; generated drift yok
- [ ] `pnpm verify`
- [ ] `pnpm alpha:accept`
- [ ] Opt-in gerçek hesap/model ile `pnpm alpha:canary`
- [ ] `pnpm alpha:lifecycle` temiz install/start/stop/restart, migration ve backup/restore provası
- [ ] 1280×720 browser kabulü
- [ ] 390×844 browser kabulü
- [ ] Browser tab'ları ve dev process'leri kapalı
- [ ] 3000/3100 dinleyen kabul süreci yok
- [ ] Geçici DB, WAL/SHM, artifact, workspace ve Codex home kalmadı
- [ ] `git diff --check`
- [ ] WP12 commit'i dışında `git status --short` temiz

## Browser matrisi

Her iki viewport'ta session oluşturma/yakın session navigasyonu, readiness/auth,
timeline reload/reconnect, approval context/sonuç, Git status/diff/log, durable audit,
loading/empty/stale/error durumları kontrol edilir. `document.documentElement.scrollWidth`
viewport genişliğini aşmamalı; console warning/error ve Vite overlay bulunmamalıdır.

## Failure kuralı

Her eksik, atlanan veya ölçülemeyen kontrol release blocker'dır. `alpha:accept` gerçek
canary çalıştırmaz. Canary auth/model erişimi yüzünden çalıştırılamazsa deterministic gate
geçmiş olsa bile sonuç `çalıştırılamadı` olarak raporlanır; başarıya çevrilmez.
