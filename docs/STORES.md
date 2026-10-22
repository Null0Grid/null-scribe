# Publishing Null Scribe to Linux app stores

Every release already puts the Flatpak, Snap and AUR files on GitHub. Getting them into the stores themselves
needs a one-time sign-up with each, under the NULLGRID name. After that, releases update the Snap Store and the AUR
automatically; Flathub updates by a small pull request.

## Flathub (Flatpak)

Flathub is what Fedora, Linux Mint, Pop!_OS, elementary and the Steam Deck show in their software centres.

One time:

1. Fork <https://github.com/flathub/flathub> and create a branch named `dev.nullgrid.scribe`.
2. Put these files in it (from this repo, `packaging/`, and the release):
   - `dev.nullgrid.scribe.yml` (the release asset `dev.nullgrid.scribe.flathub.yml`, renamed)
   - `null-scribe.sh` (`packaging/flatpak/`)
   - `dev.nullgrid.scribe.desktop`, `dev.nullgrid.scribe.metainfo.xml`, `dev.nullgrid.scribe.png` (`packaging/linux/`)
   - `flathub.json` with `{ "only-arches": ["x86_64", "aarch64"] }`
3. Open a pull request against `flathub/flathub`'s `new-pr` branch titled "Add dev.nullgrid.scribe". A reviewer checks it,
   usually within a week or two. Expect questions about the permissions; the reasons are commented in
   `scripts/render-packaging.js` (`FINISH_ARGS`).
4. Once merged you get a repo `flathub/dev.nullgrid.scribe`. Verify the app ID by putting the token Flathub gives you at
   `https://nullgrid.dev/.well-known/org.flathub.VerifiedApps.txt`, so the listing shows a verified checkmark.

Each release: replace `dev.nullgrid.scribe.yml` in `flathub/dev.nullgrid.scribe` with the new release's
`dev.nullgrid.scribe.flathub.yml` (it already has the new URLs and checksums) and merge the pull request Flathub's bot builds.

The app is proprietary, so the metainfo says `LicenseRef-proprietary`. Flathub allows that because NULLGRID owns the app
and lets Flathub redistribute it.

## Snap Store

1. Create an Ubuntu One account at <https://snapcraft.io> and sign in to the Snap Store dashboard.
2. Register the name: `snapcraft register null-scribe` (or "Register a snap name" on the dashboard).
3. Make a CI login and store it as a repository secret:
   ```
   snapcraft export-login --snaps=null-scribe --channels=stable --acls=package_upload credentials.txt
   ```
   Paste the file's contents into **Settings → Secrets and variables → Actions → New secret** named
   `SNAPCRAFT_STORE_CREDENTIALS`, then delete `credentials.txt`.
4. In the dashboard, request auto-connection of `audio-record` for null-scribe (forum post in the "store-requests"
   category). Until it's granted, users run `sudo snap connect null-scribe:audio-record` once.

After that, the Release workflow uploads both `.snap` files to the stable channel.

## AUR (Arch / Manjaro)

1. Create an account at <https://aur.archlinux.org> and add an SSH public key to it (My Account → SSH Public Key).
2. Create the package once from any Linux machine:
   ```
   git clone ssh://aur@aur.archlinux.org/null-scribe-bin.git
   cd null-scribe-bin
   # copy the release assets null-scribe-bin.PKGBUILD → PKGBUILD and null-scribe-bin.SRCINFO → .SRCINFO
   git add PKGBUILD .SRCINFO && git commit -m "Initial import" && git push
   ```
3. Store the matching SSH **private** key as the repository secret `AUR_SSH_PRIVATE_KEY`.

After that, the Release workflow pushes the new `PKGBUILD` and `.SRCINFO` with every release.

## What runs where

| | Mic recording | Import files | Meeting mode (chosen apps) | Notes / Drive |
|---|---|---|---|---|
| `.deb`, `.rpm`, AppImage, `.tar.gz`, AUR | ✅ | ✅ | ✅ (needs PipeWire tools) | ✅ |
| Flatpak | ✅ | ✅ | ❌ not inside the sandbox | ✅ (vaults in ~/Documents, others via `flatpak override`) |
| Snap | ✅ after `snap connect null-scribe:audio-record` | ✅ in your home folder | ❌ not inside the sandbox | ✅ |
