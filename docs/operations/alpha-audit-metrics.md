# Alfa audit, health ve metrics işletim notu

## Yüzeyler

- `GET /healthz`: yalnız control-plane process liveness; dependency kontrolü yapmaz.
- `GET /readyz`: `x-tenant-id` ve `x-workspace-id` ile database, artifacts, workspace, auth ve app-server check'lerini döndürür. Hazır değilse HTTP 503 üretir.
- `GET /metrics`: bounded JSON aggregate. Harici exporter veya scrape kurulumu gerektirmez.
- `GET /v1/sessions/:sessionId/audit?limit=25&cursor=...`: scope zorunlu, keyset-cursor sayfalı durable audit.

Response ve loglarda provisioning source, workspace/artifact path, credential, prompt, model çıktısı, reasoning, diff ve command output bulunmamalıdır. Audit metadata yeni bir anahtar gerektirirse önce ADR allowlist'i, contract ve leakage testi birlikte güncellenir. Metric label'a hiçbir domain kimliği eklenmez.

## Retention ve kapasite

Varsayılan audit sınırı 30 gün, 10.000 kayıt ve toplam 8 MiB metadata'dır. Tek kayıt metadata'sı en çok 2 KiB'dır. Her append transaction'ı zaman, kayıt ve byte sınırını oldest-first uygular. Alfa operatörü SQLite dosyasını elle düzenlememeli; backup audit tablosunu event store ile birlikte kapsamalıdır.

## Arıza yorumu

- `/healthz=200`, `/readyz=503`: process canlı, en az bir dependency kullanıma hazır değil.
- auth check `AUTH_REQUIRED`: `codex login` çalıştırıp readiness retry yapılır; credential API'ye verilmez.
- appServer failed: yeni turn başlatılmaz; mevcut durable timeline ve audit salt-okunur kalır.
- database/artifacts/disk failed: yeni yazma etkileri durdurulur ve dependency düzeldikten sonra readiness deterministik olarak tekrar `ready` olur.

Metrics process restart'ında sıfırlanan operasyon aggregate'larıdır; durable doğruluk kaynağı audit ve domain store'dur.
