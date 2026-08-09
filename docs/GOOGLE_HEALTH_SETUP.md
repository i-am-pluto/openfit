# Complete Guide: Connect OpenFit to Google Health

This guide documents the setup used to connect OpenFit to Fitbit data through the Google Health API. It was last updated on August 9, 2026, for Google sign-in.

Signing in to OpenFit and granting it health access are one Google authorization. There is no separate "connect a health account" step, and OpenFit has no screen that accepts a Client ID or a Client Secret — the server reads them from `.env`.

## Before You Start

You need:

- the Google account used in the Fitbit mobile app;
- access to [Google Cloud Console](https://console.cloud.google.com/);
- a checkout of this repository, which you will start with `npm run serve`;
- Fitbit Air already paired and synchronized with the Fitbit app on the phone.

The data flow is:

```text
Fitbit Air -> Fitbit mobile app -> Google Health API -> OpenFit
```

OpenFit does not perform the first Bluetooth pairing and does not replace synchronization between the tracker and the phone.

## 1. Create a Google Cloud Project

1. Open [Create Google Cloud project](https://console.cloud.google.com/projectcreate).
2. In **Project name**, enter `OpenFit`.
3. For a personal account, leave **Organization** set to `No organization`.
4. Click **Create**.
5. Wait for creation to finish, then select `OpenFit` from the project selector in the top bar.

From this point on, always verify that **OpenFit** is the selected project. The API, OAuth consent, and OAuth client must belong to the same project.

## 2. Enable the Google Health API

1. With the OpenFit project selected, open [Google Health API](https://console.cloud.google.com/apis/library/health.googleapis.com).
2. Click **Enable**.
3. Wait until **API enabled** appears or the button changes to **Manage**.

If **Manage** already appears, the API is enabled and you can continue.

## 3. Configure Google Auth Platform

1. Open [Google Auth Platform -> Overview](https://console.cloud.google.com/auth/overview).
2. Check again that the selected project is OpenFit.
3. Click **Get started**.
4. In app information, enter:
   - **App name:** `OpenFit`
   - **User support email:** your Google address
5. Choose **External** as the audience.
6. In **Contact information**, enter your email.
7. Accept the user data policy and finish the wizard with **Continue** or **Create**.

### Why External

`Internal` is reserved for users in the same Google Workspace organization. `External` allows a normal personal Google account to authorize the app. During development, the app remains in Testing mode and can only be used by manually added test users.

## 4. Add the Fitbit Account as a Test User

1. Open [Google Auth Platform -> Audience](https://console.cloud.google.com/auth/audience).
2. In **Test users**, click **Add users**.
3. Enter the Google address used in the Fitbit app.
4. Click **Save**.
5. Verify that the address appears in the list.

The account selected in the browser when signing in must be the same account listed here.

## 5. Enable Read-Only Scopes

1. Open [Google Auth Platform -> Data Access](https://console.cloud.google.com/auth/scopes).
2. Click **Add or remove scopes**.
3. Search for `Google Health API`.
4. Select the read-only scopes listed below.
5. Click **Update**, then **Save**.

```text
https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly
https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly
https://www.googleapis.com/auth/googlehealth.ecg.readonly
https://www.googleapis.com/auth/googlehealth.irn.readonly
https://www.googleapis.com/auth/googlehealth.location.readonly
https://www.googleapis.com/auth/googlehealth.nutrition.readonly
https://www.googleapis.com/auth/googlehealth.profile.readonly
https://www.googleapis.com/auth/googlehealth.settings.readonly
https://www.googleapis.com/auth/googlehealth.sleep.readonly
```

Do not select write scopes. OpenFit also requests the standard `openid` and `profile` scopes to display the account name and avatar.

## 6. Create the OAuth Client

1. Open [Google Auth Platform -> Clients](https://console.cloud.google.com/auth/clients).
2. Click **Create client**.
3. For application type, choose **Web application**.
4. Use `OpenFit` as the name.
5. Leave **Authorized JavaScript origins** empty.
6. Under **Authorized redirect URIs**, add `<origin>/auth/callback` for every origin you will open OpenFit at. For a local server on the default port:

   ```text
   http://127.0.0.1:7788/auth/callback
   ```

   Add `http://127.0.0.1:7789/auth/callback` too if you will develop with `npm run dev`; `dev:api` listens on 7789, which is a different origin.

   Add `http://127.0.0.1:7790/auth/callback` if you will use the desktop app. It binds that one fixed port deliberately: an arbitrary loopback port is allowed only for a **Desktop app** client, and this is a **Web application** client, so every port must be registered.

   Add another entry if you will also reach OpenFit over an HTTPS tailnet origin:

   ```text
   https://your-host.tail-abc123.ts.net/auth/callback
   ```

7. Click **Create**.
8. Store the **Client ID** and **Client Secret** shown by Google.

Do not publish, share, or commit these credentials.

## 7. Why the Callback Looks Like That

The callback is a route on the OpenFit server itself — `/auth/callback` — not a temporary listener OpenFit opens for the duration of a consent flow. The old loopback callback on port `42813` no longer exists.

Google accepts only an `http://127.0.0.1` loopback redirect or an `https://` one. A plain `http://<tailnet-host>:7788/...` callback cannot be registered at all, which is why signing in from another device requires putting HTTPS in front of the server and setting `OPENFIT_PUBLIC_ORIGIN`.

Sign-in only completes on the origin the client is registered with: the short-lived pending cookie is set on the origin the browser started from, and Google returns to the registered redirect URI. `state`, `nonce`, and PKCE are all verified at the callback.

The callback must match the Google Cloud registration character by character, including protocol, host, port, and path.

## 8. Write `.env` and Sign In

1. Create `.env` in the repository root:

   ```bash
   cp .env.example .env
   ```

2. Fill in the values from step 6:

   ```bash
   OPENFIT_GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   OPENFIT_GOOGLE_CLIENT_SECRET=...
   # Only when HTTPS fronts the server, e.g. via `tailscale serve`:
   # OPENFIT_PUBLIC_ORIGIN=https://your-host.tail-abc123.ts.net
   ```

   Without these the server exits with status 1 before it starts. `npm run dev` fails the same way and takes Vite and Electron down with it.

3. Start OpenFit:

   ```bash
   npm run serve
   ```

4. Open the URL the startup banner prints — it must be the origin whose `/auth/callback` you registered.
5. Click **Sign in with Google** on the page OpenFit serves.
6. Select the Google account added as a test user.
7. Approve the requested access. The one consent covers both sign-in and read-only health scopes.
8. You land on the dashboard and the first sync starts automatically.

## 9. Final Verification

The configuration is working when:

- OpenFit shows `Google Health` instead of `Demo data`;
- a last synchronization time appears;
- the Devices page shows Fitbit Air or the paired tracker;
- steps, heart rate, or sleep contain real data;
- `<data-dir>/accounts/<hash>/` exists with mode `0700` and holds the encrypted credential and cache files.

Metric availability depends on the device, region, granted consent, and recent Fitbit mobile synchronization.

## Troubleshooting

### `OPENFIT_GOOGLE_CLIENT_ID is not set`

The server found no `.env` and no service environment. It prints that one line and exits 1. Under `npm run dev`, `concurrently -k` then kills Vite and Electron, so the whole command dies with no further explanation.

### `redirect_uri_mismatch`

Register `<origin>/auth/callback` for the exact origin you opened OpenFit at, for example:

```text
http://127.0.0.1:7788/auth/callback
```

Do not use `localhost` where you registered `127.0.0.1`, do not omit `/auth/callback`, and do not add spaces or a trailing slash. Opening OpenFit at a tailnet IP while only the loopback callback is registered produces this error too.

### `Sign-in took too long. Start again.`

The pending sign-in cookie lasts ten minutes and is cleared after any callback, successful or not. This also appears when the browser began at one origin and Google returned to a different one.

### `That Google account has no verified email address.`

OpenFit keys an account on the Google subject and requires a verified email. Verify the address with Google and sign in again.

### `Access blocked`, `access_denied`, or Unauthorized User

- Verify that the audience is **External**.
- Add the correct Google account under **Audience -> Test users**.
- During login, select the same account used in the Fitbit app.

### `invalid_client`

- Copy the Client ID and Client Secret again from the same `OpenFit` client into `.env`, then restart the server.
- Make sure no leading or trailing spaces were copied.
- Do not mix credentials from different projects.

### 403 Error or API Not Enabled

Open the Google Health API page and verify that **Manage** appears. The API must be enabled in the same project that contains the OAuth client.

### Port 7788 Is Already in Use

Another OpenFit instance is running, or choose a different port with `--port`. Remember that changing the port changes the origin, so the new `<origin>/auth/callback` has to be registered too.

### The Browser Authorizes the App but Sign-In Does Not Complete

- keep the OpenFit server running during the whole consent flow;
- start from the origin whose callback is registered, not a different address for the same machine;
- check that VPNs or proxies are not intercepting the callback;
- clear cookies for the OpenFit origin and try again.

### Some Metrics or Sections Are Missing

1. Open the Fitbit app on the phone.
2. Wait for Fitbit Air to synchronize.
3. Return to OpenFit and refresh the day.
4. Check effective source coverage on the **Data** page.

ECG, SpO2, temperature, HRV, and irregular rhythm notifications may not be available for every device, account, or country. OpenFit automatically hides sections without data.

### The Connection Stops Working After Seven Days

In Google OAuth `Testing` mode, refresh tokens normally expire after seven days. You stay signed in; only health access lapses. Click **Reconnect** in OpenFit, which forces a fresh consent screen, or complete Google's requirements to move the app to production.

## Quick Checklist

- [ ] `OpenFit` project created and selected
- [ ] Google Health API enabled
- [ ] Google Auth Platform configured
- [ ] Audience set to `External`
- [ ] Fitbit account added as a test user
- [ ] Google Health `.readonly` scopes added
- [ ] `OpenFit` client created as a web application
- [ ] `<origin>/auth/callback` registered exactly, for every origin used
- [ ] Client ID and Client Secret written to `.env`
- [ ] Server started with `npm run serve` and its banner URL opened
- [ ] Consent completed with the correct account
- [ ] First sync completed

## Official References

- [Google Health API: Cloud and OAuth setup](https://developers.google.com/health/setup)
- [Google Health API: scopes](https://developers.google.com/health/scopes)
- [Google Health API: data types](https://developers.google.com/health/data-types)
- [Google OAuth for web applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google OAuth for desktop applications](https://developers.google.com/identity/protocols/oauth2/native-app)
