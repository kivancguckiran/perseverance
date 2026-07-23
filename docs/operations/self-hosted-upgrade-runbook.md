# Self-hosted upgrade runbook'u (WP32)

- Durum: Yürürlükte
- Tarih: 2026-07-23
- Kapsam: WP32 (ADR-0032)

## İlkeler

- Upgrade hiçbir senaryoda conversation/attachment kaybetmez: önce otomatik
  yedek alınır, migration'lar expand-only politikayla (release-supply-chain
  `lintMigration`) tracking tablosu üzerinden uygulanır.
- Önceki sürüm kaydı (`${SELF_HOSTED_HOME}/state/previous-release.env`) rollback
  için saklanır.

## Adımlar

1. Kaynak checkout'unu yeni sürüme getirin (veya yeni imzalı bundle'ı doğrulayın):

   ```bash
   git fetch && git checkout <yeni-sürüm>   # worktree temiz olmalı
   # bundle ile: SELF_HOSTED_RELEASE_BUNDLE=<dizin>  (verify-release otomatik koşar)
   ```

2. Upgrade'i çalıştırın:

   ```bash
   bash infra/self-hosted/self-hosted.sh upgrade
   ```

   Sırasıyla: otomatik ön-yedek → (varsa) bundle imza/provenance doğrulaması →
   yeni product imajının build'i → `migrate` (uygulanmamış migration'lar; içeriği
   değişmiş eski migration'da fail-closed) → servislerin yeni sürüme geçişi →
   public `/readyz` doğrulaması.

3. Doğrulayın:

   ```bash
   bash infra/self-hosted/self-hosted.sh status
   ```

## Başarısız upgrade

- Readiness gelmezse komut fail-closed sonlanır ve stack eski veriyle ayakta
  kalmaz duruma göre; hemen `self-hosted-rollback-runbook.md` uygulayın.
- Upgrade öncesi otomatik yedek `${SELF_HOSTED_HOME}/backups` altındadır;
  gerekirse `self-hosted.sh restore <yedek>` ile geri dönün.

## Kabul kanıtı

`pnpm wp32:lifecycle` gate'i upgrade → veri doğrulama → rollback zincirini
uçtan uca koşar ve session kaybı olmadığını satır sayımıyla kanıtlar.
