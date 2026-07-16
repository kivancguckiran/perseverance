# WP18 public route authorization coverage

Doğruluk kaynağı:
`services/control-plane/src/server.ts#PUBLIC_ROUTE_AUTHORIZATION_CATALOG`.
`/healthz`, `/v1/meta`, CORS preflight ve tek kullanımlık opaque artifact grant consume
route'u dışında `/v1/*`, `/readyz` ve `/metrics` için katalog kaydı zorunludur.
Katalog dışı yeni route runtime'da `AUTHZ_ROUTE_UNCOVERED` ile fail-closed olur; coverage
testi duplicate/eksik action-resource kaydını reddeder.

| Yüzey                         | Action                                                           | Resource         |
| ----------------------------- | ---------------------------------------------------------------- | ---------------- |
| `/v1/me`                      | `session.read`                                                   | principal        |
| `/readyz`                     | `provider.readiness.read`                                        | workspace        |
| `/metrics`                    | `metrics.read`                                                   | metrics          |
| session list/detail           | `session.read`                                                   | session          |
| session create/update/resume  | `session.create` / `session.update`                              | session          |
| turn start/steer/interrupt    | `turn.start` / `turn.steer` / `turn.interrupt`                   | turn             |
| event REST replay             | `event.replay`                                                   | event            |
| realtime subscribe/ack        | `event.subscribe`                                                | realtime/session |
| approval list/detail/decision | `approval.read` / `approval.decide`                              | approval         |
| attachment upload/delete      | `attachment.upload` / `attachment.delete`                        | attachment       |
| artifact metadata/read/grant  | `artifact.metadata.read` / `artifact.read` / `artifact.download` | artifact         |
| Git snapshots                 | `workspace.snapshot.read`                                        | git snapshot     |
| usage/cost                    | `usage.read` / `usage.reconcile`                                 | usage            |
| audit                         | `audit.read`                                                     | audit            |
| conversation folders          | `folder.read` / `folder.manage`                                  | folder           |
| provider catalog/readiness    | `provider.catalog.read` / `provider.readiness.read`              | provider         |

## Role/action policy

| Rol       | Okuma/replay     | Turn/mutation | Approval  | Usage reconcile | Folder manage |
| --------- | ---------------- | ------------- | --------- | --------------- | ------------- |
| owner     | allow            | allow         | allow     | allow           | allow         |
| admin     | allow            | allow         | allow     | allow           | allow         |
| developer | allow            | allow         | allow     | deny            | allow         |
| viewer    | allow            | deny          | read-only | deny            | deny          |
| billing   | usage/audit only | deny          | deny      | allow           | deny          |

Workspace override listesi boşsa organization membership bütün organization
workspace'lerine uygulanır. Liste doluysa yalnız listedeki workspace'ler allow olur.
Revoked/disabled organization membership her rolden üstündür ve deny üretir.
