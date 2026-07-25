import { failNotRun, machineEvidence } from './wp30-evidence'

const gate = 'wp34:provider-smoke'
const allowed = process.env.WP34_PROVIDER_SMOKE_ALLOWED === '1'
const provider = process.env.WP34_PROVIDER_SMOKE_PROVIDER?.trim()
const credential = process.env.WP34_PROVIDER_SMOKE_CREDENTIAL?.trim()
if (!allowed || !provider || !credential)
  failNotRun(gate, [
    'WP34_PROVIDER_SMOKE_ALLOWED=1',
    'WP34_PROVIDER_SMOKE_PROVIDER',
    'WP34_PROVIDER_SMOKE_CREDENTIAL',
  ])

// Bu gate provider credential'ı asla çıktı/evidence'a yazmaz. Gerçek network
// smoke adapter'ı provider bazında açıkça kayıt edilmeden generic HTTP çağrısı yapmaz.
machineEvidence(gate, {
  accepted: false,
  status: 'not-run',
  productionEvidence: false,
  missing: [`approved-${provider}-smoke-adapter`],
})
process.exitCode = 1
