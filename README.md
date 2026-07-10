# Rate Ninja

Rate Ninja is a small web application for browsing ocean freight rates, sailing schedules, and company-specific margins stored in Airtable.

## What changed

The application now runs through a local Node server. Airtable is no longer called from browser code, so its personal access token and the administrator write capability stay on the server. Browser sessions are stored in an HTTP-only cookie, and the server enforces the user's rate view and administrator scope.

## Run locally

1. Use Node.js 20 or later.
2. Copy `.env.example` to `.env` and fill in a newly created Airtable personal access token and a long random session secret. Do not reuse the token that was previously committed to this repository.
3. Start the app:

   ```bash
   npm start
   ```

4. Open [http://localhost:3000](http://localhost:3000).

The app uses only Node's built-in modules, so `npm install` is not required.

## Configuration

`AIRTABLE_PAT` and `SESSION_SECRET` are required. The Airtable base and table identifiers have sensible defaults and can also be changed in `.env`.

## Security note

The Airtable token that was embedded in the old client-side application should be revoked in Airtable immediately, because it was committed to Git history. The current user table also appears to store passwords as plain text. This refactor keeps them out of the browser, but moving authentication to a provider that stores password hashes is the recommended next step.

## Checks

```bash
npm run check
```

## Render demo deployment

The included `render.yaml` creates a free Render web service. In Render, choose **New → Blueprint**, select this repository, and supply a newly rotated `AIRTABLE_PAT` and a separate `RATE_NINJA_API_KEY` when prompted. Render generates `SESSION_SECRET` automatically and publishes the app at an `onrender.com` URL.

Free services sleep after 15 minutes of inactivity, so the first request afterward can take about a minute to respond.
