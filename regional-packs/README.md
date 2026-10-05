# Regional offline product snapshots

These partial Germany, Sweden and EU packs are checked into the repository and published with APK releases. Download them in Android Settings → Offline product data, or import their JSON files manually. The stable catalog is https://github.com/D3SOX/veguide/releases/download/offline-data/catalog.json and points to versioned release assets.

Data comes from Open Food Facts, Open Beauty Facts and Open Products Facts. Each JSON retains source URLs, retrieval dates and product modification dates. Database license: [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/); individual contents: [DBCL 1.0](https://opendatacommons.org/licenses/dbcl/1-0/). These licenses are independent of the application's AGPL license. Preserve attribution and comply with applicable share-alike requirements when redistributing derived databases.

Each pack includes at most 10,000 products, is capped at 10 MB, and is not a complete country's database or certification registry. The catalog records byte counts and SHA-256 digests. Pack downloads and updates require an explicit action; no account or Veguide server is involved. GitHub receives the ordinary download request.

To refresh, run `bun scripts/offline-snapshot.ts --region sweden --output regional-packs/sweden.json --strict` (likewise `germany` and `eu`). The generator reuses valid data for seven days; add `--force` to refresh sooner. Commit the updated packs, then publish a version tag. The release workflow validates the files, generates a catalog with versioned asset URLs, publishes the files, and finally updates the stable catalog. Dates remain truthful if a pack has not been refreshed.
