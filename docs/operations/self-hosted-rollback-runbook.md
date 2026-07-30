# Self-hosted rollback runbook'u (WP32)

- Durum: Yürürlükte
- Tarih: 2026-07-23
- Kapsam: WP32 (ADR-0032)

## Ne zaman

Upgrade sonrası readiness gelmiyor, regresyon görülüyor veya sürüm geri
alınmak isteniyorsa.

## Adımlar

```bash
bash infra/self-hosted/self-hosted.sh rollback
```

- Önceki sürüm kaydı (`state/previous-release.env`) ve imajı yerinde olmalıdır;
  rollback servisleri önceki product imajına döndürür ve `/readyz` doğrular.
- Migration'lar expand-only olduğundan şema GERİ ALINMAZ; yeni kolon/tablolar
  eski sürümle uyumlu biçimde yerinde kalır ve veri kaybı yaşanmaz.
- Şema-uyumsuz bir acil durumda (beklenmez), upgrade öncesi otomatik yedeğe
  dönün:

  ```bash
  bash infra/self-hosted/self-hosted.sh restore \
    "${SELF_HOSTED_HOME:-/var/lib/perseverance}/backups/<upgrade-öncesi>.tar.enc"
  ```

## Doğrulama

```bash
bash infra/self-hosted/self-hosted.sh status
```

Conversation/attachment sayılarının korunması `pnpm wp32:lifecycle` gate'inin
rollback adımında satır sayımı ile kanıtlanır.
