# Manufacturer replies on Cloudflare

`/submit` accepts anonymous manufacturer responses in English, German or Swedish. `/replies` searches approved contributions by valid GTIN + country, or exact normalized product name + brand + country. `/review` is a private moderator interface protected by a bearer access code. Contributions remain separate from the product verdict and local history.

The Worker uses D1 for structured records, a **private** R2 bucket for attachments, and Turnstile for submission verification. It serves the static forms itself; Pages and a separately managed server are unnecessary. No contributor account, email address, analytics or IP address is stored in the database. Cloudflare receives requests and may retain platform security logs under its policies. Worker observability is disabled.

## Current service

- [Submit a manufacturer reply](https://veguide-community.withered-flower-f0f2.workers.dev/submit)
- [Find reviewed replies](https://veguide-community.withered-flower-f0f2.workers.dev/replies)
- [Moderator queue](https://veguide-community.withered-flower-f0f2.workers.dev/review)

The configuration points to the deployed Worker and EU D1/R2 resources. Their `veguide-community` names were created before the Vegsnap rename; keep these bindings to use the existing service and storage. Submissions are open. The initial `ADMIN_TOKEN` review code and `TURNSTILE_SECRET` are stored in the local, Git-ignored `packages/community/.dev.vars` file with permissions `0600`, and as Cloudflare Worker secrets. Copy the review code into your password manager; do not put it in a URL, commit, screenshot or public comment. It is not a contributor sign-in credential. If the local file is lost, rotate `ADMIN_TOKEN` using Wrangler instead of trying to retrieve the deployed secret. Future deployments retain Worker secrets.

## Deploy

Run commands from `packages/community`, after `bun install` in the repository root. `bun x wrangler whoami` must show `d1:write` and `challenge-widgets.write` in addition to Worker/account permissions. Refresh authorization if needed:

```sh
bun x wrangler login --device --scopes account:read user:read workers:write workers_scripts:write workers_routes:write zone:read d1:write challenge-widgets.write
```

Enable R2 in the Cloudflare dashboard if the account has not used it before. Inspect existing resources before creating these names; do not overwrite an unrelated service.

```sh
bun x wrangler d1 list
bun x wrangler r2 bucket list
bun x wrangler d1 create veguide-community --jurisdiction eu
bun x wrangler r2 bucket create veguide-community-evidence --jurisdiction eu
```

Copy the returned D1 ID into `wrangler.jsonc`. Both storage resources use the EU jurisdiction. Keep the R2 bucket private: do not enable `r2.dev` or attach a public bucket domain.

Set `PUBLIC_ORIGIN` to the exact HTTPS Worker origin (no trailing slash), for example `https://veguide-community.<your-subdomain>.workers.dev`. Create a managed Turnstile widget restricted to that hostname:

```sh
bun x wrangler turnstile widget create veguide-community --domain <worker-hostname> --mode managed
```

Set `TURNSTILE_SITE_KEY` in `wrangler.jsonc`. Store the widget secret and a random review access code with Wrangler, never in committed files or URLs. Generate the review code using a password manager (at least 32 random characters), retain it there, and paste it when prompted:

```sh
bun x wrangler secret put TURNSTILE_SECRET
bun x wrangler secret put ADMIN_TOKEN
bun run migrate:remote
bun run deploy
```

Deploy initially with `SUBMISSIONS_ENABLED: "false"`. Check `/api/config`, the forms, the empty lookup and protected review API. Then set `SUBMISSIONS_ENABLED: "true"` and redeploy. Put the verified service origin into `data/community-service.json` under `baseUrl` to enable the Android and extension actions. An empty value hides them; no request is made just by viewing a product result. Android displays reviewed replies in the app after an explicit lookup, sending only a valid GTIN + country or exact product name + brand + country. Missing details can be filled in without changing the saved result. Sharing opens the hosted form in a Custom Tab using the user’s browser; source links and reviewed attachments also use Custom Tabs. The extension opens the hosted pages in a browser. Form links pass product identity in the URL fragment. The form removes the fragment after reading it. Only an explicit submission uploads the form and selected attachment.

To rotate moderator access, run `bun x wrangler secret put ADMIN_TOKEN` again. The review page holds the code in tab memory, clearing it on reload/sign-out. Every review write checks a revision number so concurrent moderators cannot silently overwrite each other.

## Review and retention

1. Open `/review`, enter the access code, and download the private evidence.
2. Compare the question, response, date, product variant, country and scope with the evidence. Approval means a moderator checked the contribution, **not** independent authentication of the sender.
3. Remove personal information from public text. Approve with the attachment checkbox off unless you checked the attachment's redaction and metadata too. PDFs are not automatically stripped or redacted. Publishing attachments always uses a download response with a sandbox policy.
4. Reject inaccurate contributions. Rejecting an approved record immediately withdraws its text and attachment from public routes. Downloaded copies cannot be recalled.

Image uploads are re-encoded as PNG in the browser, resized to at most 2400 pixels, previewed and limited to 2 MB. The server also removes PNG text/EXIF metadata. Filenames are replaced; the original filename is not retained. Contributors must redact visible personal information themselves. Original submitted text and moderation notes are private and excluded from public endpoints. Pending submissions expire after 30 days; rejected ones expire 7 days after review. An hourly job deletes expired records and attachments. Approved records are retained until withdrawn; monitor storage growth.

Submissions are capped at 5 per minute per edge/IP by a rate-limit binding and **100 total per UTC day** atomically in D1. This bounds accepted upload growth; it is not a guarantee against Cloudflare billing for traffic or long-term storage. The account's existing Cloudflare billing configuration applies. Failed storage attempts also consume the daily allowance. Turnstile is verified server-side with hostname and action checks. Changing the service hostname requires updating the origin, widget restriction and app config together.

`GET /api/snapshot` exports approved text only in pages of 200, using the returned `nextCursor`. The lookup page can download these as JSON. This is a community dataset export, not an Open Facts offline pack; neither app imports it into verdict evaluation. An export can span concurrent moderation edits; it is not a transactional snapshot. Product lookup returns the latest 50 matching contributions and flags additional results. Scope and dates are displayed without treating an ingredient-only reply as whole-product confirmation.

## Validation

```sh
bun run typecheck
bun run test
bun x wrangler deploy --dry-run
```

The integration suite runs the actual Worker with disposable local D1/R2 instances. Turnstile verification uses a test-only outbound handler. It verifies privacy boundaries, publication/withdrawal, concurrency, country/GTIN matching, limits and expiry. No production credentials or existing database are used. `test/browser-fixture.ts` serves the same forms against disposable local storage for browser checks; its Turnstile key and review code are test values and must never be deployed.

The initial schema is `0001_submissions.sql`, already applied to the current service. For development changes that exist only in local test databases, edit the original migration and reset this package's ignored `.wrangler/state`; this loses **only that local test data**. Changes to an existing production schema need a new migration.
