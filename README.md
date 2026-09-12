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
