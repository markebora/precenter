# Song database and Google sign-in (done once, by you)

Your users set up nothing: they open PreCenter and press **Continue with Google**.

## 1. Your project (already filled in)
`window.DSC_SUPABASE` near the top of `index.html` holds your Project URL and publishable key.
Keep `precenter-desktop/app/index.html` identical. **Never** put a `service_role` / `sb_secret_` key there.

## 2. Run the SQL again
**SQL Editor > New query**, paste all of `supabase-setup.sql`, **Run**. Safe to run again. It makes songs private to each account and adds size limits. Run it before deploying.

## 3. Allow the sign-in to come back
**Authentication > URL Configuration**
- Site URL: `https://disciples-precenter.vercel.app`
- Redirect URLs (add both):
  - `https://disciples-precenter.vercel.app/**`
  - `http://127.0.0.1:53682/**`  (desktop app)

## 4. Open Google sign-in to the public
- Google Cloud Console > **OAuth consent screen** (Google Auth Platform > Audience): **External**, and **Publish app** ("In production").
  While it says "Testing", only the test users you list can sign in.
- Supabase > **Authentication > Sign In / Providers > Google**: on, with your Client ID and secret.
- Supabase > **Authentication > Sign In / Providers**: "Allow new users to sign up" must be on.

## 5. Publish
1. Deploy to Vercel.
2. Build a new desktop installer (the old one cannot do Google sign-in) and release it.

## Good to know
- Each account sees only its own songs. People who are not signed in keep songs on their computer only.
- You, as the project owner, can still see rows in the Supabase dashboard. To block a person: Authentication > Users.
- Many lyrics are copyrighted; answer removal requests (Table Editor > songs).
- The free plan has limited database space, and pauses after a week without use; press **Restore** in the dashboard.
