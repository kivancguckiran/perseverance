# ADR-0010: Salt-okunur Git snapshot ve session görünürlüğü

- Durum: Kabul adayı
- Tarih: 14 Temmuz 2026
- Kapsam: Faz 1 WP10 workspace ve Git görünürlüğü

## Bağlam

Normalize `fileChange` ve turn diff event'leri Codex'in bildirdiği değişiklikleri taşır,
ancak workspace'in son durumunda Git doğruluk kaynağıdır. Browser'dan cwd veya Git
argümanı almak data-plane güvenlik sınırını bozar; büyük diff'i API/SQLite içinde tam
string olarak tutmak WP7 bounded artifact kararını ihlal eder.

## Karar

- Git okuyucu Workspace Agent paketinde, canonical server-owned workspace ile bir kez
  kurulur. Dış API cwd, path, Git argümanı veya operation kabul etmez.
- Git yalnız `execFile` ve sabit allowlist argüman dizileriyle çağrılır. Shell
  interpolation kullanılmaz; environment, timeout ve output üst sınırı sabittir.
- Snapshot branch, HEAD, detached durumu, porcelain-v2 değişiklikleri, staged,
  unstaged, untracked, rename, binary, submodule bilgisi, bounded diff ve en çok 20 log
  kaydı taşır. No-repo, worktree ve submodule ayrı typed sonuçlardır.
- Turn başlamadan önce ve authoritative `turn.completed` ingest edildikten sonra alınan
  snapshot, tenant/workspace/session/turn ve stable idempotency key ile schema v5
  `git_snapshots` tablosuna yazılır. Manuel refresh yeni immutable snapshot üretir.
- Diff preview UTF-8 güvenli 64 KiB ile sınırlı ve redacted'dır. Daha büyük, hard-limit
  içindeki diff WP7 artifact storage'a `git-diff` türüyle chunk edilip finalize edilir;
  API yalnız opaque artifact ID döndürür ve mevcut scoped, kısa ömürlü download grant
  hattını kullanır.
- UI Git snapshot'ı authoritative olarak işaretler; normalize file-change sayısıyla
  uyum veya ayrışmayı ayrıca görünür kılar. Snapshot 30 saniye sonra stale gösterilir.
- Yakın session listesi `(updated_at, session_id)` keyset cursor'ıyla sayfalanır ve her
  sorguda tenant/workspace scope zorunludur.

## Sonuçlar

Git mutation, remote credential ve restore yüzeyi oluşmaz. Git snapshot arızası Codex
turn etkisini ikinci kez doğurmaz; manuel refresh typed hata verir, turn akışı ise mevcut
idempotency semantiğini koruyarak devam eder. Hard output limitini aşan diff açık hata
üretir ve process belleği sınırsız büyümez.
