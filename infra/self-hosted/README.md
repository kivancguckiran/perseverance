# Self-hosted dağıtım (WP32)

Persistent Codex Workspace'i kendi VPS'inizde veya makinenizde tek komutla kurmak
için:

```bash
bash infra/self-hosted/self-hosted.sh install \
  --domain workspace.example.com --acme-email admin@example.com
```

- Mimari kararlar: `docs/architecture/adr-0032-self-hosted-distribution.md`,
  `docs/architecture/adr-0037-user-accounts-passphrase-privacy.md` (WP37
  kullanıcı hesapları + parola-türevli at-rest mahremiyet)
- Kurulum: `docs/operations/self-hosted-install-runbook.md`
- Upgrade: `docs/operations/self-hosted-upgrade-runbook.md`
- Rollback: `docs/operations/self-hosted-rollback-runbook.md`
- Yedekleme/geri yükleme: `docs/operations/self-hosted-backup-restore-runbook.md`
- Kaldırma (export ile): `docs/operations/self-hosted-uninstall-runbook.md`

Kabul gate'leri: `pnpm wp32:test`, `pnpm wp32:preflight`, `pnpm wp32:install-smoke`,
`pnpm wp32:lifecycle`, `pnpm wp32:credential-scan`, `pnpm wp32:golden`,
`pnpm wp32:accept`; WP37 için ayrıca `pnpm wp37:test` ve `pnpm wp37:privacy`
(operatör-okuyamaz kanıtı).

Kullanıcı yönetimi (WP37): `set-allowed-users "ad1,ad2"` ile allowlist'i
belirleyin; kullanıcılar `https://<domain>/login` üzerinden kayıt olur ve
içerikleri parola-türevli anahtarla şifrelenir. `list-users`, `disable-user`,
`reset-user --crypto-erase` operatör komutlarıdır.
