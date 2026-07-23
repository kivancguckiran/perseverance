# Self-hosted yedekleme ve geri yükleme runbook'u (WP32)

- Durum: Yürürlükte
- Tarih: 2026-07-23
- Kapsam: WP32 (ADR-0032)

## Yedek modeli

- `self-hosted.sh backup`: uygulama-tutarlı `pg_dump -Fc` (tüm conversation,
  approval, billing ve audit verisi) + object storage arşivi (attachment ve
  artifact'lar) + workspace verisi + manifest, tek arşivde toplanır ve
  **her durumda** `openssl enc -aes-256-cbc -pbkdf2` ile şifrelenir.
- Şifreleme anahtarı: `${SELF_HOSTED_HOME}/secrets/backup-key` (0600). **Bu
  anahtar olmadan yedekler açılamaz.** Anahtarı host dışında güvenli bir yerde
  (parola kasası/escrow) saklamak zorunlu operasyon adımıdır.
- Provider credential'ları (codex-home) varsayılan olarak yedeğe **dahil
  edilmez**; `--include-provider-credentials` bayrağıyla dahil edilse bile arşiv
  şifrelidir ve plaintext credential hiçbir çıktına düşmez (`wp32:credential-scan`
  kanıtlar).
- Çevrimiçi yedek postgres için tutarlıdır; object storage tarafı yoğun yazma
  altında crash-consistent'tir. Tam sessiz yedek için düşük trafik penceresi
  önerilir. Daha güçlü RPO gereken kurulumlar için wp27 PITR hattı
  (`pnpm wp27:postgres-pitr` deseni) uygulanabilir.

## Yedek alma

```bash
bash infra/self-hosted/self-hosted.sh backup            # varsayılan: ${SELF_HOSTED_HOME}/backups
bash infra/self-hosted/self-hosted.sh backup --output /mnt/harici-disk
```

Çıktı: `backup-<UTC damgası>.tar.enc` + `.sha256`. Düzenli yedek için cron/systemd
timer ile aynı komutu zamanlayın ve çıktı dizinini host dışına taşıyın.

## Geri yükleme

```bash
bash infra/self-hosted/self-hosted.sh restore /yol/backup-....tar.enc
```

Sırasıyla: sha256 doğrulaması → şifre çözme (backup-key ile) → uygulama
servislerinin durdurulması → `pg_restore --clean` → object/workspace verisinin
geri yüklenmesi → migration/rol tazeleme → servislerin açılması → public
`/readyz` doğrulaması. Restore hiçbir adımda kısmî durumda "başarılı" raporlamaz.

Yeni bir host'a taşınma: önce aynı sürümle `install` koşun (yeni secret'lar
üretilir), `backup-key`'i eski host'tan `${SELF_HOSTED_HOME}/secrets/backup-key`
konumuna kopyalayın, sonra `restore` çalıştırın.

## Kabul kanıtı

`pnpm wp32:lifecycle`: yedek → bilinçli veri silme → restore → satır sayımıyla
sıfır kayıp; export arşivinin `database.dump` içerdiği ve şifreli olduğu
doğrulanır.
