# Offline product data

`bundle.json` is a compact, text-only snapshot of Open Food Facts, Open Beauty Facts and Open Products Facts. It is a selection, **not a complete regional database**. Community records and packaging label claims do not establish independent certification. Ingredient lists retain their original language and are never marked complete just because a database contains them.

Database: [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
Individual contents: [Database Contents License 1.0](https://opendatacommons.org/licenses/dbcl/1-0/).
These data licenses are separate from Veguide's AGPL source license. Retain attribution and the source/date metadata when redistributing the snapshot; derived database reuse remains subject to ODbL.

Sources:

- [Open Food Facts](https://world.openfoodfacts.org): the project's [Mirabelle export service](https://mirabelle.openfoodfacts.org/products). [Official country-export guidance](https://support.openfoodfacts.org/help/fr-fr/12-donnees-api/89-je-souhaite-un-export-csv-pour-un-pays-une-marque-en-particulier) describes this service. Build queries project only product identifiers, name, brand, composition, countries and modification time.
- [Open Beauty Facts](https://world.openbeautyfacts.org): `https://static.openbeautyfacts.org/data/en.openbeautyfacts.org.products.csv.gz`.
- [Open Products Facts](https://world.openproductsfacts.org): `https://static.openproductsfacts.org/data/en.openproductsfacts.org.products.csv.gz`.

The shared schema contains `schemaVersion: 1`, `generatedAt`, `region`, `sources` and `products`. Each source carries its own original URL, database license and retrieval date. Each product retains its source ID and original modification timestamp. No photos, contributor identifiers, personal notes, or provider data are included. The English-named upstream exports can contain product descriptions in other languages; a build never invents translations.

## Refresh and build caching

```sh
bun run data:offline
bun run data:offline --force --strict
```

Android asset builds and the extension's `build:firefox` / `build:chromium` scripts run this preparation automatically. Builds require Bun. A validated bundled snapshot is reused for seven days; all included source retrieval dates must also remain within that window. Beauty/products compressed source downloads are cached for seven days under ignored `artifacts/offline/source-cache`, with SHA-256 verification. Builds share a process lock. The snapshot is replaced atomically only after all sources succeed and validation passes.

A failed refresh keeps an existing valid snapshot and prints its original date and age. A first build without any valid snapshot fails if retrieval fails; `--strict` also rejects failed refreshes instead of falling back. Ordinary tests exercise mocked downloads and do not fetch datasets. The tracked real snapshot supports offline builds while it is fresh, and remains a clearly dated fallback afterward.

The default `de-eu` recipe requests up to 4,000 food records sold in Germany, 1,500 in Sweden excluding Germany, and 2,500 in other EU markets excluding both. Food selection uses descending upstream scan popularity and then barcode, not random sampling. Up to 1,000 beauty and 1,000 general-product records are added, prioritizing Germany then Sweden, records with composition, and barcode. All selected records pass exact-country, field-size and GTIN-checksum checks. Cross-source barcode duplicates are retained once, in food/beauty/products order. Final records are sorted by canonical barcode. The whole snapshot is bounded to 10,000 records and 10 MB (10,000,000 bytes); filtering can produce fewer records. Product composition is rejected if over its bound, never truncated into apparently complete evidence.

## Optional regional packs

```sh
bun run data:offline --region sweden
bun run data:offline --region germany
bun run data:offline --region eu
```

These create `artifacts/offline/<region>.json`, using the same schema and seven-day cache, with up to 8,000 food + 1,000 beauty + 1,000 general-product records. Import the JSON file through Veguide's offline-data settings. `--output /path/to/pack.json` selects a different destination. Optional packs are not silently added to the APK or extension bundle. There is currently no hosted regional-pack download feed.

Wikidata's full database and certification registries are not bundled: Wikidata is not a product-composition catalog, and no open bulk redistribution feed has been established for the certification registries. Public search access alone is not a license to redistribute their complete databases.
