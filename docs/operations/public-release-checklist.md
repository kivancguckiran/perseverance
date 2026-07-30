# Public release checklist

- Durum: Yürürlükte
- Tarih: 2026-07-23
- Kapsam: WP31 (ADR-0031) + WP32 self-hosted release adımları (ADR-0032)

Repository'nin public mirror'a açılması ve her public release yayımı bu
checklist'i izler. Repository'nin fiilen public yapılması yönetici kararıdır;
bu checklist kararın ön koşullarını mekanikleştirir.

## 1. Zorunlu gate'ler (her release)

Sırayla ve temiz working tree üzerinde:

1. `pnpm verify` — format, typecheck, test, build, SSR smoke.
2. `pnpm release:public-preflight` — tek deterministik gate:
   - zorunlu hijyen dosyaları (LICENSE, NOTICE, SECURITY, CONTRIBUTING,
     CODE_OF_CONDUCT, SUPPORT, politika belgeleri),
   - gitignore secret dizin kapsamı,
   - working tree + tam Git history secret taraması
     (`infra/release/wp31-gitleaks.toml`, redakte evidence
     `.wp31/evidence/` altına yazılır),
   - dependency lisans gate'i + commit edilmiş deterministik SBOM/lisans
     raporu drift kontrolü (`infra/release/wp31-sbom.cdx.json`,
     `infra/release/wp31-license-report.json`),
   - temiz klonda non-interactive `CI=true`
     `pnpm install --frozen-lockfile && pnpm verify` (operatörün açık `CI`
     değeri korunur).
3. Determinizm kanıtı: preflight'ı iki kez ardışık çalıştırın;
   `.wp31/evidence/wp31-public-preflight.json` iki koşuda bayt-aynı olmalıdır.
4. Docker mevcut ortamda authoritative tarayıcı koşusu (resmî gitleaks +
   syft + grype): `pnpm wp29:security-scans`. Bu koşu wp31 offline
   tarayıcısının üstünde ikinci ve bağımsız doğrulamadır.

## 2. İmzalı artifact ve provenance (wp29 hattı)

Public release artifact'i yayımlanmadan önce:

1. `pnpm wp29:reproducible-build` — temiz worktree'de reproducible build.
2. `pnpm wp29:sbom` — release artifact'leri için syft SBOM'ları.
3. `pnpm wp29:signatures` — artifact + SBOM + SLSA provenance imzaları
   (cosign). İmza doğrulaması ve tamper kanıtı bu gate'in içindedir.
4. Checksum, signature ve provenance dosyalarını release notlarıyla birlikte
   yayımlayın.

## 2a. Self-hosted release adımları (WP32, ADR-0032)

Self-hosted dağıtım artifact'i yayımlanacaksa, §2'deki imza hattının üzerine:

1. `pnpm wp32:test` — dağıtım invariantlarının statik kabulü (pin, compose,
   script hijyeni, credential taraması).
2. Çok mimarili release bundle üretimi (linux/amd64 + linux/arm64):

   ```bash
   COSIGN_KEY_FILE=<anahtar> COSIGN_PUB_FILE=<pub> \
     bash infra/self-hosted/release/build-release.sh --output dist/self-hosted-release
   ```

   Çıktı: `product-oci.tar`, `self-hosted-dist.tar`, `release-manifest.json`,
   `SHA256SUMS`, cosign imzaları, `provenance.intoto.json`, `trust-policy.json`.

3. Doğrulama provası: temiz bir makinede
   `bash infra/self-hosted/self-hosted.sh verify-release <bundle>` fail-closed
   geçmeli; imzasız/bozuk bundle reddedilmelidir.
4. Kurulum kabulü: her iki mimaride `pnpm wp32:preflight`,
   `pnpm wp32:install-smoke`, `pnpm wp32:lifecycle`, `pnpm wp32:credential-scan`
   ve self-hosted kurulum üzerinde `pnpm wp32:golden` (PWA golden senaryosu).
   `not-run` kalan gate release notlarında açıkça listelenir ve fail-closed
   sayılır.
5. Runbook seti güncel olmalı: `docs/operations/self-hosted-*.md`.

## 3. Publish öncesi yönetici kararları (ilk açılış)

- [ ] Ürün/community adı kararı — "Codex" marka riski
      (`docs/policies/brand-and-endorsement-policy.md`) çözülmüş olmalı.
- [ ] Public mirror hedefi (org/repo), branch koruması ve issue şablonları.
- [ ] `SECURITY.md` iletişim kanalının izlendiğinin doğrulanması.
- [ ] ADR-0031 lisans kararının son gözden geçirmesi (AGPL-3.0-only).
- [ ] History taşıma kararı: WP31 taraması gerçek secret bulmadığı için
      history olduğu gibi taşınır; yeni bir bulgu çıkarsa önce rotate,
      gerekirse rewrite (ADR-0031 stratejisi).

## 4. Publish sonrası

- [ ] Release tag + imzalı artifact'lerin yayımlandığının doğrulanması.
- [ ] README rozet/link'lerinin public URL'lerle çalıştığının kontrolü.
- [ ] İlk community issue/PR akışında `CONTRIBUTING.md` adımlarının bir dış
      katkıcı gözüyle denenmesi.

## Evidence ve redaksiyon

- Preflight evidence'ı (`.wp31/evidence/`) zaman damgası içermez ve
  redaktedir; secret değerleri hiçbir evidence dosyasına yazılmaz.
- `.wp31/` gitignore kapsamındadır ve commit edilmez; kabul raporlarına yalnız
  özet sayılar ve checksum'lar taşınır.
