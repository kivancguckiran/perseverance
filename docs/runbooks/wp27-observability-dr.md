# WP27 Observability ve disaster recovery runbook

## API availability

İki burn-rate penceresini, active region readiness ve PostgreSQL/broker/object/KMS
dependency sonuçlarını kontrol et. Admission'ı fail-closed tut; içerik veya credential
loglama. Instance arızasında load balancer health recovery, region arızasında aşağıdaki
promotion akışını kullan.

## Backup/restore

Backup manifest hash-chain, component checksum, source LSN/event/object watermark ve
key version'ı doğrulanmadan restore başlatma. İzole target oluştur; PostgreSQL, key
metadata, objects, broker ve derived index sırasını uygula. Tenant graph, duplicate
turn/runtime-start, gapless event sequence ve audit chain gate'lerinden biri geçmezse
target admission'ını açma ve evidence'ı failed olarak kapat.

## Region failover

Eski authority'yi fence et, admission'ı kapat, split-brain olmadığını kanıtla. Passive
PostgreSQL watermark, broker/object/KMS/runtime readiness ve contract compatibility
geçince authority epoch'u tek transaction ile artır. Replay ve integrity gate'leri
sonrasında admission aç. Ölçülen RPO/RTO hedef dışındaysa servis dönmüş olsa bile
tatbikatı başarısız say.

## KMS veya corrupt backup

`RESTORE_KEY_UNAVAILABLE`, `BACKUP_COMPONENT_MISSING` veya
`BACKUP_COMPONENT_CORRUPT` durumunda plaintext/başka key/eksik component fallback'i
yoktur. Restore'u durdur, target'ı izole bırak ve page alert üret.

## Cleanup

Harness'e ait process, container, volume, temporary credential ve evidence staging
dizinlerini envanterle. Evidence hash'i kalıcı immutable store'a doğrulandıktan sonra
geçici kaynakları kaldır; sıfır envanter doğrulanmadan koşumu başarılı kapatma.
