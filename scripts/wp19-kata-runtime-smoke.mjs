import { spawnSync } from 'node:child_process'

const runtimeClass = process.env.WP19_KATA_RUNTIME_CLASS ?? 'kata-qemu'
const storageClass = process.env.WP19_ENCRYPTED_STORAGE_CLASS
const image = process.env.WP19_SMOKE_IMAGE ?? 'alpine:3.22'
const namespace = `wp19-smoke-${Date.now()}`

function run(args, input) {
  const result = spawnSync('kubectl', args, {
    encoding: 'utf8',
    input,
    timeout: 240_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(
      `kubectl ${args.join(' ')} failed: ${result.stderr || result.stdout}`,
    )
  return result.stdout.trim()
}

function cleanup() {
  spawnSync(
    'kubectl',
    ['delete', 'namespace', namespace, '--wait=true', '--timeout=120s'],
    {
      encoding: 'utf8',
      timeout: 150_000,
    },
  )
}

if (!storageClass) {
  console.error(
    'WP19_ENCRYPTED_STORAGE_CLASS is required; a normal Docker/local smoke is not production isolation evidence.',
  )
  process.exit(2)
}

try {
  run(['version', '--client=true'])
  const runtime = JSON.parse(
    run(['get', 'runtimeclass', runtimeClass, '-o', 'json']),
  )
  const storage = JSON.parse(
    run(['get', 'storageclass', storageClass, '-o', 'json']),
  )
  const storageEvidence = JSON.stringify(storage.parameters ?? {}).toLowerCase()
  if (
    !storageEvidence.includes('encrypt') &&
    !storageEvidence.includes('kms') &&
    !storageEvidence.includes('key')
  )
    throw new Error(
      'storage class does not expose encryption/KMS evidence in its parameters',
    )

  run(['create', 'namespace', namespace])
  run(['label', 'namespace', namespace, 'persistent-codex.io/wp19-smoke=true'])
  const manifest = `
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
  namespace: ${namespace}
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: workspace
  namespace: ${namespace}
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: ${storageClass}
  resources:
    requests:
      storage: 1Gi
---
apiVersion: v1
kind: Pod
metadata:
  name: workspace-a
  namespace: ${namespace}
spec:
  runtimeClassName: ${runtimeClass}
  automountServiceAccountToken: false
  hostNetwork: false
  hostPID: false
  hostIPC: false
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    runAsUser: 65534
    seccompProfile: {type: RuntimeDefault}
  containers:
    - name: smoke
      image: ${image}
      command: [sh, -c, "trap : TERM INT; sleep 600 & wait"]
      securityContext:
        allowPrivilegeEscalation: false
        privileged: false
        readOnlyRootFilesystem: true
        capabilities: {drop: [ALL]}
      volumeMounts:
        - {name: workspace, mountPath: /workspace}
        - {name: tmp, mountPath: /tmp}
  volumes:
    - name: workspace
      persistentVolumeClaim: {claimName: workspace}
    - name: tmp
      emptyDir: {medium: Memory, sizeLimit: 8Mi}
---
apiVersion: v1
kind: Pod
metadata:
  name: workspace-b
  namespace: ${namespace}
spec:
  runtimeClassName: ${runtimeClass}
  automountServiceAccountToken: false
  hostNetwork: false
  hostPID: false
  hostIPC: false
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    runAsUser: 65534
    seccompProfile: {type: RuntimeDefault}
  containers:
    - name: smoke
      image: ${image}
      command: [sh, -c, "while true; do nc -l -p 8080 < /dev/null; done"]
      securityContext:
        allowPrivilegeEscalation: false
        privileged: false
        readOnlyRootFilesystem: true
        capabilities: {drop: [ALL]}
      volumeMounts:
        - {name: tmp, mountPath: /tmp}
  volumes:
    - name: tmp
      emptyDir: {medium: Memory, sizeLimit: 8Mi}
`
  run(['apply', '-f', '-'], manifest)
  run([
    'wait',
    '--namespace',
    namespace,
    '--for=condition=Ready',
    'pod/workspace-a',
    '--timeout=120s',
  ])
  run([
    'wait',
    '--namespace',
    namespace,
    '--for=condition=Ready',
    'pod/workspace-b',
    '--timeout=120s',
  ])
  const pod = JSON.parse(
    run(['get', 'pod', 'workspace-a', '-n', namespace, '-o', 'json']),
  )
  if (pod.spec.runtimeClassName !== runtimeClass)
    throw new Error('pod did not use the selected Kata RuntimeClass')
  const node = JSON.parse(run(['get', 'node', pod.spec.nodeName, '-o', 'json']))
  const guestKernel = run([
    'exec',
    '-n',
    namespace,
    'workspace-a',
    '--',
    'uname',
    '-r',
  ])
  if (!guestKernel || guestKernel === node.status.nodeInfo.kernelVersion)
    throw new Error(
      'pod kernel did not differ from the Kubernetes host kernel; Kata microVM execution was not proven',
    )
  const pvc = JSON.parse(
    run(['get', 'pvc', 'workspace', '-n', namespace, '-o', 'json']),
  )
  if (
    pvc.status.phase !== 'Bound' ||
    pvc.spec.storageClassName !== storage.metadata.name
  )
    throw new Error(
      'encrypted workspace PVC was not bound to the selected class',
    )
  if (
    pod.spec.volumes.some(
      (volume) => volume.hostPath || volume.nfs || volume.local,
    )
  )
    throw new Error('host-backed path mount detected')
  const metadataAttempt = spawnSync(
    'kubectl',
    [
      'exec',
      '-n',
      namespace,
      'workspace-a',
      '--',
      'sh',
      '-c',
      'wget -T 2 -qO- http://169.254.169.254/latest/meta-data/',
    ],
    { encoding: 'utf8', timeout: 15_000 },
  )
  if (metadataAttempt.status === 0)
    throw new Error('cloud metadata endpoint was reachable')
  const serviceTokenAttempt = spawnSync(
    'kubectl',
    [
      'exec',
      '-n',
      namespace,
      'workspace-a',
      '--',
      'sh',
      '-c',
      'test -e /var/run/secrets/kubernetes.io/serviceaccount/token',
    ],
    { encoding: 'utf8', timeout: 15_000 },
  )
  if (serviceTokenAttempt.status === 0)
    throw new Error('service account token was mounted')
  const workspaceB = JSON.parse(
    run(['get', 'pod', 'workspace-b', '-n', namespace, '-o', 'json']),
  )
  const crossRuntimeAttempt = spawnSync(
    'kubectl',
    [
      'exec',
      '-n',
      namespace,
      'workspace-a',
      '--',
      'nc',
      '-z',
      '-w',
      '2',
      workspaceB.status.podIP,
      '8080',
    ],
    { encoding: 'utf8', timeout: 15_000 },
  )
  if (crossRuntimeAttempt.status === 0)
    throw new Error('cross-runtime tenant network connection was allowed')
  console.log(
    JSON.stringify({
      status: 'passed',
      backend: 'kata-kubernetes',
      runtimeClass: runtime.metadata.name,
      runtimeHandler: runtime.handler,
      isolationLevel: 'microvm',
      guestKernelDistinctFromHost: true,
      encryptedStorageClass: storage.metadata.name,
      encryptedPvc: 'bound',
      metadataAccess: 'denied',
      crossRuntimeAccess: 'denied',
      serviceAccountTokenMount: 'denied',
      hostPathMounts: 'none',
      egressPolicy: 'default-deny',
    }),
  )
} catch (error) {
  console.error(
    JSON.stringify({
      status: 'failed',
      backend: 'kata-kubernetes',
      reason: error instanceof Error ? error.message : String(error),
      note: 'This is a required real-infrastructure proof; local process or normal Docker is not accepted as a substitute.',
    }),
  )
  process.exitCode = 1
} finally {
  cleanup()
}
