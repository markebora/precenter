# Song database and Google sign-in (done once, by you)

Your users set up nothing: they open PreCenter and press **Continue with Google**.

## 1. Put your project in the app
Supabase > **Project Settings > API**. Open `index.html`, find `window.DSC_SUPABASE` near the top and paste:

```js
window.DSC_SUPABASE={
  url:'https://xxxx.supabase.co',
  key:'sb_publishable_... (or the anon key, eyJ...)'
};
```

Copy the same `index.html` to `precenter-desktop/app/index.html` (the two files must match).
The publishable/anon key is meant to be public. **Never** use the `service_role` / `sb_secret_` key.

## 2. Run the SQL again
**SQL Editor > New query**, paste all of `supabase-setup.sql`, **Run**. Safe to run again; it adds size limits for public use.

## 3. Allow the sign-in to come back
**Authentication > URL Configuration**
- Site URL: `https://precenter-bay.vercel.app`
- Redirect URLs (add both):
  - `https://precenter-bay.vercel.app/**`
  - `http://127.0.0.1:53682/**`  (desktop app)

## 4. Open Google sign-in to the public
- Google Cloud Console > **OAuth consent screen** (Google Auth Platform > Audience): **External**, and **Publish app** ("In production").
  While it says "Testing", only the test users you list can sign in.
- Supabase > **Authentication > Sign In / Providers > Google**: on, with your Client ID and secret.
- Supabase > **Authentication > Sign In / Providers**: "Allow new users to sign up" must be on.

## 5. Publish
1. Deploy to Vercel.
2. Build a new desktop installer (the old one cannot do Google sign-in) and release it.

## Before you share it
- Everyone can read every song in the database, even without signing in. Anyone with a Google account can add songs,
  and their whole local library is uploaded once they sign in.
- Lyrics are often copyrighted. Sharing them publicly may need permission or a licence.
- To remove a bad song: Table Editor > songs > set `deleted` to true. To block a person: Authentication > Users.
- Free projects pause after a week without use; press **Restore** in the dashboard.
