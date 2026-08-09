# Desktop Release

> **Not yet exercised end to end.** `electron/main.cjs` is composed and covered
> by `electron/main.test.ts`, but no packaged artifact has been launched against
> a real Google client on this branch. Two things must be true before one works,
> and neither is something the build can arrange:
>
> - `http://127.0.0.1:7790/auth/callback` is registered on the OAuth client. The
>   desktop app binds that one fixed port because a **Web application** client
>   must have every redirect URI registered exactly.
> - A `.env` holding `OPENFIT_GOOGLE_CLIENT_ID` and `OPENFIT_GOOGLE_CLIENT_SECRET`
>   exists in the app's user data directory. `.env` is not in the `files` list
>   below and `app.asar` is read-only, so a packaged build cannot carry one; it
>   reads the user data directory instead and shows a dialog naming the path
>   when the file is absent. See
>   [SELF_HOSTING.md](SELF_HOSTING.md#where-a-packaged-app-reads-env).
>
> A distributable build therefore targets someone who owns a Google Cloud
> project, not a general audience. Shipping a Client Secret inside a binary
> would not make it a secret.

## Local Package Status

`npm run dist` produces macOS DMG and ZIP artifacts that are ready for local testing. If a **Developer ID Application** identity is not installed, electron-builder intentionally creates an unsigned artifact. That is suitable for development and personal use, not public distribution.

## Public macOS Checklist

1. Join the Apple Developer Program and install a Developer ID Application certificate in the CI machine keychain.
2. Configure electron-builder or CI with the certificate and password through secrets, never in the repository.
3. Configure Apple notarization with App Store Connect credentials stored in CI secrets.
4. Run `npm run check`, `npm audit --omit=dev`, and `npm run dist` on a clean macOS runner.
5. Verify signature, hardened runtime, notarization, and Gatekeeper on the final DMG.
6. Publish SHA-256 checksums and keep immutable build artifacts.

## Other Platforms

- Windows: sign the NSIS installer with a code-signing certificate and validate SmartScreen behavior.
- Linux: publish AppImage and DEB artifacts with checksums. If distributed through a repository, sign the repository.

Code signing cannot be simulated in source code. It requires identities and credentials owned by the distributor.
