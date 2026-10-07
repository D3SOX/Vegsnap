# Browser extension releases

Stable GitHub releases submit new versions to the existing listings:

- [Firefox / AMO](https://addons.mozilla.org/en-US/developers/addon/vegsnap/versions): `vegsnap@vegsnap.app`
- [Chrome Web Store](https://chrome.google.com/webstore/devconsole/2513f243-a48e-4c7d-b2c1-483b3c1dafb2/pkkfmbgdbdoccbdngnbfpjjhpldmphej/edit/status): `pkkfmbgdbdoccbdngnbfpjjhpldmphej`

Both stores still review updates. A successful workflow means the version was submitted or Chrome was skipped because an older version is still under review; check the workflow summary for the result. Chrome requests automatic publication after approval. Existing listing text, graphics, privacy disclosures, license and distribution settings remain managed in the store dashboards. Update those manually when features or disclosures change. Firefox receives release notes, reviewer instructions and the matching source archive with every submission.

## One-time authentication

Set these [repository Actions secrets](https://github.com/D3SOX/vegsnap/settings/secrets/actions). Browser sign-in does not authenticate GitHub Actions.

| Secret | Value |
| --- | --- |
| `AMO_JWT_ISSUER` | AMO API credential JWT issuer |
| `AMO_JWT_SECRET` | AMO API credential JWT secret |
| `CHROME_CLIENT_ID` | Google OAuth client ID |
| `CHROME_CLIENT_SECRET` | Google OAuth client secret |
| `CHROME_REFRESH_TOKEN` | Offline refresh token authorized by the Chrome publisher account |

### AMO

Open [Manage API Keys](https://addons.mozilla.org/en-US/developers/addon/api/key/) in the account that owns Vegsnap. Generate credentials, then save the issuer and secret. AMO only shows the full secret when generating it. Regenerating an existing credential revokes the old one, so coordinate other consumers first. [Mozilla's authentication documentation](https://mozilla.github.io/addons-server/topics/api/auth.html) explains these credentials.

### Chrome

Follow [Google's Chrome Web Store API setup](https://developer.chrome.com/docs/webstore/using-api):

1. Select a Google Cloud project and enable the Chrome Web Store API.
2. Configure an external OAuth consent app and add the publisher account as a test user while setting it up.
3. Set the OAuth app's publishing status to **In production** before generating the long-lived refresh token. External apps left in Testing have refresh tokens that expire after seven days for this scope. Publishing the consent app and completing verification are separate processes; follow Google's displayed requirements for this app. [Google's token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration) describe other reasons a token can stop working.
4. Create a **Web application** OAuth client, with `https://developers.google.com/oauthplayground` as an authorized redirect URI.
5. In [OAuth Playground](https://developers.google.com/oauthplayground), open settings, select **Use your own OAuth credentials**, and enter that client ID and secret.
6. Authorize `https://www.googleapis.com/auth/chromewebstore` using the Google account that owns the store listing. Exchange the authorization code for tokens and save the **refresh token**, not the temporary access token.

You can enter secrets without putting their values in shell history:

```sh
gh secret set AMO_JWT_ISSUER --repo D3SOX/vegsnap
gh secret set AMO_JWT_SECRET --repo D3SOX/vegsnap
gh secret set CHROME_CLIENT_ID --repo D3SOX/vegsnap
gh secret set CHROME_CLIENT_SECRET --repo D3SOX/vegsnap
gh secret set CHROME_REFRESH_TOKEN --repo D3SOX/vegsnap
```

Each command prompts for its value. Keep credentials out of repository files, release assets and issue comments.

## Publishing a version

1. Increase `extension/package.json`'s version to the stable release version, for example `0.2.9` for tag `v0.2.9`. WXT takes the manifest version from this file. Store versions must increase.
2. Run the existing **Release apps and companion** workflow on that commit or push its version tag.
3. That workflow builds both browsers from one offline data snapshot, preserves the existing signed sideload packages, and adds these store assets to the GitHub release:
   - `vegsnap-chrome-store.zip`: Chrome upload ZIP without the sideload public key.
   - `vegsnap-firefox.xpi`: Firefox build.
   - `vegsnap-firefox-source.zip`: corresponding source, lockfile, offline data and rebuild instructions.
   - `submission.json` and `store-listing.json`: checksums, identities and reviewer instructions.
4. Once the GitHub release is published, **Publish browser extensions** submits each store independently. Prereleases are excluded. Validation stops mismatched tags, package versions, identities or modified assets before submission.

The release workflow explicitly calls the publishing workflow because events created using `GITHUB_TOKEN` do not start additional workflows. The publishing workflow also handles `release: published` events from releases published manually or with another token. These releases must already contain the store assets above; it does not rebuild binaries or refresh live data during submission. Old releases without these assets cannot be submitted by this workflow.

## Retry and review

Use **Re-run failed jobs** after fixing a failed submission. Alternatively, run **Publish browser extensions** manually with the existing release tag and select `amo` or `chrome` to retry only that store:

```sh
gh workflow run publish-extension-stores.yml --repo D3SOX/vegsnap \
  -f tag=v0.2.9 -f store=chrome
```

Chrome retries recognize the same version already pending review or published, and publish an approved staged version without uploading again. When an older version is pending review, Chrome submission is skipped without failing the release or changing that review. The workflow summary records the pending and skipped versions. Once the review finishes, manually run the publishing workflow for the latest release with `store=chrome`; skipped versions are not automatically queued. A newer pending version or a different staged version still needs attention in the dashboard. Rejected versions need review and a corrected version. Upload processing is polled up to 60 times, ten seconds apart; review approval is not polled.

AMO rejects duplicate versions. Check its dashboard after a timeout before retrying: if that version is already present, do not submit it again. Select only the other store when it needs a retry. Listed AMO submissions succeed once upload and validation finish, without waiting for manual review or a signed XPI download. The GitHub Firefox asset stays unsigned; install the signed store version through AMO.
