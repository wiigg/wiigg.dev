# wiigg.dev

Personal website built with [Hugo](https://gohugo.io/) and the
[Anatole](https://github.com/lxndrblz/anatole) theme, deployed to GitHub Pages.

## Requirements

- Hugo Extended 0.166.0 (also pinned in `.github/workflows/deploy-hugo.yaml`).
- Go 1.24.3 or later to download the theme as a Hugo module.
- Dart Sass on `PATH`; Anatole 1.20.0 uses it to compile its stylesheets.

On macOS with Homebrew:

```sh
brew tap dart-lang/dart
brew trust --formula dart-lang/dart/dart
brew trust --formula dart-lang/dart/dart-beta
brew install hugo go sass/sass/sass
```

Homebrew checks the Dart beta formula for conflicts when installing stable Dart;
the command above does not install the beta SDK.

## Development

```sh
hugo server
```

Open http://localhost:1313. Hugo downloads the theme version pinned in `go.mod`
automatically on the first build.

To preview unpublished posts locally, run `hugo server --buildDrafts`. This also
includes the archived MCIT drafts; production builds exclude all drafts.

## Writing posts

Posts live in `content/post/`. Keep `draft: true` in the front matter until a
post is ready to publish. Titles retain their written casing, and dates use
British formatting.

The homepage shows approximately 50-word automatic summaries with a "Read more"
link for truncated articles. For an intentional introduction, set `summary` in
the post's front matter or put `<!--more-->` after the opening paragraphs. Set
`description` separately for the page's search and sharing description.

For longer articles with headings, add `toc: true` to the front matter to show
a table of contents. Leave it unset on short essays.

The RSS link points to `/post/index.xml` and includes full articles. Page
metadata uses `static/images/social-card.png` unless a post specifies its own
`images` list. Homepage introduction text lives in `content/_index.md`.

Editable SVG originals sit alongside the sharing image and favicons. Keep the
PNG and ICO exports in sync with those originals when changing the branding.

## Article likes

Published posts can show anonymous heart buttons before the date and reading time
and after the article. Both controls share the same count and toggle state.
The Hugo site stays on GitHub Pages; `likes-api/` contains a Cloudflare Worker
and a D1 database that store the likes. The only new development dependency is
Cloudflare's Wrangler CLI, used to run, test and deploy the Worker; the deployed
code has no package dependencies.

`params.likes.endpoint` in `config.toml` is the Worker origin, without `/likes`.
An empty endpoint disables the button. The public `/likes.json` manifest lists
eligible posts automatically, so publishing another article does not require a
backend deployment. Draft, future and expired posts are excluded.

Set a post's `likesId` to a permanent, unique lowercase identifier such as
`the-questions-we-ask`. Otherwise its filename (without `.md`) is used. Preserve
this identifier when changing titles, URLs or filenames to retain existing
likes. Use only lowercase letters, digits and hyphens, up to 100 characters.

Readers need no account. The browser remembers a random identifier after their
first like; the database allows one like per identifier and article. This is
one vote per browser, not a verified count of people. Clearing browser storage
or using another browser permits another vote. The application stores no IP
addresses; Cloudflare's rate limiter uses them transiently to limit writes.
If browser storage is unavailable, the identifier lasts only for the current
visit. Failed requests never count as successful likes.

### Local development

Use Node.js 22.13 or later (the tests use its built-in SQLite module).

```sh
cd likes-api
npm ci
npm test
npx wrangler d1 migrations apply wiigg-likes --local
npm run dev -- --var SITE_ORIGIN:http://localhost:1313 --var POSTS_URL:http://localhost:1313/likes.json
```

In another terminal at the repository root:

```sh
node --test test/likes.test.cjs
HUGO_PARAMS_LIKES_ENDPOINT=http://localhost:8787 hugo server
```

Local D1 data lives in ignored `.wrangler/` storage. Local development does not
write to the production database.

### Cloudflare setup and deployment

Use the **Workers Free** plan to meet the zero-cost hosting requirement. Confirm
the selected account's Workers plan in the Cloudflare dashboard before creating
resources or deploying; a free DNS/website plan does not establish the Workers
billing plan. Do not enable a paid plan or paid add-ons. On the free plan,
exhausted quotas make likes temporarily unavailable instead of incurring
overage charges. The blog itself continues to be served by GitHub Pages.

From `likes-api/`:

```sh
npx wrangler login --scopes account:read user:read workers_scripts:write d1:write
npx wrangler whoami
npx wrangler d1 create wiigg-likes
```

Copy the returned database ID into `wrangler.toml`, then apply the migration
and deploy:

```sh
npx wrangler d1 migrations apply wiigg-likes --remote
npm run deploy
```

Use the returned `https://...workers.dev` origin for `params.likes.endpoint`,
then publish the Hugo site. `SITE_ORIGIN` and `POSTS_URL` in the Worker config
must match the site's origin and public manifest. Until that manifest is live,
the Worker rejects likes rather than accepting arbitrary article IDs. The
Worker keeps the manifest for up to five minutes before checking for changes.

Wrangler handles authentication locally. Never put Cloudflare API tokens or
OAuth credentials in Hugo settings, browser JavaScript or Git. The Worker and
D1 database are deployed separately from the existing GitHub Pages workflow.

## Production build

```sh
hugo --gc --minify --environment production
```

Generated files go into `public/`, which is ignored by Git. Pushing to `main`
runs the GitHub Pages build and deployment workflow.

## Updates

Update the Hugo version in the deployment workflow and these requirements
together. To update the theme and its checksums:

```sh
hugo mod get github.com/lxndrblz/anatole@latest
hugo mod tidy
hugo --gc --minify --environment production
```

Commit both `go.mod` and `go.sum` so builds use the same theme release.

The local `layouts/_default/single.html` overrides Anatole's article template
to add the likes buttons. When updating the theme, compare it with the new
upstream template and preserve both `likes/widget.html` partial calls, passing
the page and the `top` or `bottom` position. The top call loads the shared assets.
