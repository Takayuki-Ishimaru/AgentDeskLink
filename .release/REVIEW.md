# Publication review

Use a dedicated, full clone containing all branches and tags that will be published, plus the candidate commit. Compare the advertised public refs with the planned promotion before checking a rewritten history. Keep approval records and reports outside the checkout, the release assets, and GitHub Actions artifacts.

## Full-history secret scan

The `history-secret-scan` job in **Beta validation** fetches complete history and verifies the Gitleaks binary before scanning. A failed scan prevents the packaging jobs from running. Only the result of the check appears in the job log.

For a local check, install Gitleaks 8.30.1 from its [official release](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1) and verify the download against the supplied checksums. Run:

```sh
python3 .release/scan_history.py --source /path/to/release-checkout --gitleaks /path/to/gitleaks
```

Add `--report /private/history-findings.json` for an investigation. The report records rule IDs and locations. The scan covers all reachable commits, including branches, tags and merge diffs. Remediate findings and rerun the scan before promoting refs.

## Human review

A reviewer familiar with the company and its customers reads the material proposed for publication. Review the public source and history, release notes and install guides, and open the actual documentation ZIP and VSIX. Compare screenshots and examples against the original source material where necessary.

- **Company and customer terminology**. Look for real company and customer names used as examples, internal project names, email addresses, hostnames, ticket or account IDs, and recognizable aliases. Replace example names with clearly fictional ones. Product and dependency names can appear where they identify actual compatibility.
- **Business design**. Inspect workflows, rules, approval paths, data models, integration diagrams, and implementation examples for organization-specific practices or client requirements. Publish only the information intended for users. Review the public release notes for development scores, measurements, and private notes.
- **Examples and media**. Open sample documents, fixtures, screenshots, and bundled assets. Look at rendered content and embedded text or metadata. Use fictional records and generic workflows.
- **Public artifacts**. Confirm the GitHub release description, shipped documentation and assets are the reviewed files. Confirm checksums and remove private review material from the payload.

Create a draft approval record against the exact candidate and files. The snapshot leaves every review unchecked.

```sh
python3 .release/review_gate.py snapshot --source /path/to/release-checkout \
  --assets /path/to/release-assets --notes /path/to/public-release-note.md > /private/publication-review.json
```

The human reviewer records their identity and a UTC timestamp and sets each review to `true` after completing it. Keep comments about sensitive terms in the private workspace. A different candidate, ref set, release note or asset requires a fresh review of the changed material and a new approval record.

## Final gate

Immediately before any publication command, run the preflight using the reviewed files:

```sh
python3 .release/release_preflight.py --source /path/to/release-checkout \
  --assets /path/to/release-assets --notes /path/to/public-release-note.md \
  --review /private/publication-review.json --gitleaks /path/to/gitleaks
```

An unchecked, absent or stale review, a checksum mismatch, or a failed history scan stops publication. Use the same preflight before manual promotion of a rewritten history. The publisher CLI also requires `--notes` and `--review` and invokes this gate before GitHub writes. If native CI rebuilds the files, verify the resulting bundle and refresh the review for its final hashes.
