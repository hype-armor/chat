# SeaweedFS recovery validation

Status: source review only. This is not a tested recovery procedure or a claim
about a running deployment. The tracked Compose file uses
`chrislusf/seaweedfs:4.50`; `Cargo.lock` pins `object_store` 0.14.2. The
SeaweedFS source reference for this review is commit
[`ec8f9793502c59ce3381cc4151bfc0806afd92e8`](https://github.com/seaweedfs/seaweedfs/tree/ec8f9793502c59ce3381cc4151bfc0806afd92e8).
Tracked configuration is not evidence of the version or services actually running.

## Multipart and lifecycle limits

The native SeaweedFS multipart implementation has mitigation for races. Do not
assume that every abort immediately removes every part: the AWS
[AbortMultipartUpload API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_AbortMultipartUpload.html)
warns that in-flight part uploads can still succeed and that repeated aborts and
verification can be necessary. This AWS caveat is not proof that a particular
SeaweedFS deployment has the same observed behavior. The tracked Compose file
does not configure a separate SeaweedFS lifecycle worker; do not assume that
lifecycle cleanup runs there.

The generic [`object_store` API](https://docs.rs/object_store/0.14.2/object_store/)
does not specify every backend recovery detail. Silence in that trait is not
proof of a SeaweedFS defect. The available evidence does not justify adding a
per-mutation ledger. Existing quota and transfer ledger requirements remain in
force.

## Backup and migration

The current SeaweedFS [Data Backup guide](https://github.com/seaweedfs/seaweedfs/wiki/Data-Backup)
describes `weed backup` with writes paused and `fs.meta.save`/`fs.meta.load`
for metadata. Follow the guide and use the same SeaweedFS version for backup and
restore. The guide warns that its approach is not bulletproof; the current wiki
can change and is not a version-pinned guarantee for 4.50. A raw copy of stopped
`/data` is not established here as a documented recovery guarantee.

For a migration or recovery exercise:

1. Exclude all writers for the entire capture window, including background jobs,
   multipart operations, and administrative writers. Confirm that in-flight
   operations have stopped before capturing anything.
2. Capture and restore SeaweedFS using its native backup and metadata procedures,
   together with PostgreSQL and the required configuration. Protect credentials
   and encryption-related configuration as sensitive data.
3. Before reopening writes, check database references against restored objects
   and verify available object hashes. Investigate missing, extra, or mismatched
   objects and test application reads.

These coordinated captures do not create an atomic cross-store snapshot. The
operator must validate consistency and recovery in an isolated environment.

## Outstanding validation

A disposable host and suitable test credentials are still required to test the
pinned version, multipart races, lifecycle behavior, and a full backup and
restore. No runtime, production service, credential, or live data was inspected
for this note. Do not treat this source review as a successful recovery drill.
