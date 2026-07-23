# Self-hosted kaldırma (uninstall-with-export) runbook'u (WP32)

- Durum: Yürürlükte
- Tarih: 2026-07-23
- Kapsam: WP32 (ADR-0032)

## Varsayılan: export ile kaldırma

```bash
bash infra/self-hosted/self-hosted.sh uninstall --export /yol/son-export-dizini
```

1. Son bir tam export arşivi üretilir (provider credential'ları dahil, arşiv
   şifreli; `backup-key` olmadan açılamaz — anahtarı ayrıca saklayın).
2. Yalnız `persistent.self-hosted=true` etiketli container/volume/network'ler
   kaldırılır (etiketsiz hiçbir kaynağa dokunulmaz) ve product imajları silinir.
3. Sıfır kalıntı doğrulanır; kalıntı varsa komut fail-closed sonlanır.
4. Durum dizini (secret'lar ve yedekler) varsayılan olarak KORUNUR; tamamen
   silmek için `--purge` ekleyin.

## Bilinçli export'suz kaldırma

Veriyi geri dönüşsüz imha etmek istediğinizden eminseniz:

```bash
bash infra/self-hosted/self-hosted.sh uninstall --skip-export --purge
```

## Doğrulama

```bash
docker ps -a --filter label=persistent.self-hosted=true   # boş olmalı
docker volume ls --filter label=persistent.self-hosted=true
docker network ls --filter label=persistent.self-hosted=true
```

`pnpm wp32:install-smoke` ve `pnpm wp32:lifecycle` gate'leri uninstall
temizliğini otomatik doğrular.
