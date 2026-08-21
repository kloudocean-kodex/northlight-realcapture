# Northlight DB replay verification

This branch is a non-production verification snapshot derived from the local remediation checkpoint `5f26a32c15bc7394ed2c7aee22b0c42ea3b180f5`.

It exists only to execute the recovered, secret-scanned database foundation and candidate migrations against an empty PostgreSQL 17 database in GitHub Actions. It is not the authoritative remediation history and must not be merged to `northlight-production` as a release artifact.

Production remains unchanged until the full release gates pass and explicit promotion approval is given.
