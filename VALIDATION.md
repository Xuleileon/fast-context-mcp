# Reliability validation

- New reliability suite: 7/7 pass, including real core HTTP-200 Connect error recovery, serialized queue, cancelled waiter ordering, active network cancellation, retry budget, Retry-After and cancellable cooldown.
- Existing suite on Windows: 130 passed, 6 failed, 4 cancelled both before and after the patch. Verified against untouched 069971f in an isolated worktree. Failures include URL.pathname used as a Windows executable path, slash-only temp directory extraction, and repo-map path assertions. Not weakened or silently skipped.
- Live STDIO smoke: upstream resource_exhausted reproduced; three bounded attempts, increasing backoff, structured trace correlation, isError:true, then terminal failure. Upstream availability is not guaranteed by this patch.
- Source logs are local only; no credentials or queries in diagnostic logs.
