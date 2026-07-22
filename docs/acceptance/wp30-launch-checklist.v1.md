# WP30 launch checklist v1

## Go/no-go

- [ ] Exact clean implementation commit ve pinli Codex `0.144.2`
- [ ] Önceki Faz 0–4 ve WP26–WP29 acceptance kapıları yeniden geçti
- [ ] ZAP ve Nuclei raw/redacted çıktıları checksum'lı
- [ ] Bağımsız pentest imzası ve retest doğrulandı; açık critical/high sıfır
- [ ] API/realtime/scheduler/provider/corpus/object/mobile load threshold'ları geçti
- [ ] En az iki saat soak sonunda RSS leak ve backlog sıfır bütçesinde
- [ ] Bütün on bir chaos bileşeni process/container injection ile recovery gösterdi
- [ ] Tenant mixing, uncontrolled duplicate ve fence violation sıfır
- [ ] Security incident/break-glass notification, immutable audit, revoke ve postmortem geçti
- [ ] Internal → design partner → limited beta → production cohort kayıtları durable
- [ ] Halt, kill switch ve rollback drill'i veri kaybı olmadan geçti
- [ ] Production browser/mobile golden senaryosu geçti
- [ ] `pnpm production:accept` ve `pnpm verify` başarılı
- [ ] Report ve evidence bundle checksum'ları yeniden doğrulandı
- [ ] Geçici/ücretli kaynak envanteri sıfır
- [ ] Resource inventory cleanup attestation imzası doğrulandı
- [ ] Immutable `go` kaydı gerçek cohort DB'sinde mevcut

## Bilinen sınırlamalar

- PWA production mobile golden authority'sidir; native iOS/Android shell bu work
  package'ın kanıtı değildir.
- Local ephemeral PostgreSQL migration testi production cohort kanıtı değildir.
- Local Ed25519 fixture bağımsız assessor imzası değildir.
- ZAP/Nuclei/k6 tool'larının bulunmaması veya target/credential eksikliği `not-run` ve
  acceptance failure üretir.
- External paid-resource cleanup provider console/finops inventory kanıtı gerektirir;
  yalnız local Docker listesi yeterli değildir.

## Launch kaydı

Nihai authority `docs/acceptance/wp30-acceptance-report.v1.json`, eşleşen `.sha256`,
evidence bundle checksum'ı ve `production_go_no_go_records` içindeki immutable record
birleşimidir. Bu checklist'in elle işaretlenmesi tek başına launch authority değildir.
