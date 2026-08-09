# Desktop Release

> **Blocked on this branch.** `electron/main.cjs` has not been recomposed for
> Google sign-in: it calls `createServer` without a session store, an accounts
> store, or an account registry, which `createServer` refuses. `npm run dist`
> still produces artifacts, but the packaged app fails at startup. Nothing below
> is worth doing until the Electron composition root is fixed.

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
