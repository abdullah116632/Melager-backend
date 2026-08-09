# Google Sign-In setup

The application code is ready. Complete the configuration below before using
the **Continue with Google** button.

1. In the [Google Cloud Console](https://console.cloud.google.com/), create or
   select a project.
2. Go to **APIs & Services → OAuth consent screen**, choose **External**, add
   the app name and support email, then add your own Google account under
   **Test users** while the app is still in testing.
3. Go to **Credentials → Create credentials → OAuth client ID** and create:
   - an **Android** client with package name `com.melager.mobile`, plus the
     SHA-1 certificate fingerprint used to sign the Android app;
   - an **iOS** client when you build for iPhone;
   - a **Web application** client when you run the web app. Add its actual
     production URL under **Authorized JavaScript origins**.
4. Copy the client IDs into `mobile/.env` as
   `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`,
   `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`, and
   `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`.
5. Add the same client IDs, comma-separated, to `GOOGLE_CLIENT_IDS` in
   `backend/.env`. Do not use or expose an OAuth client secret in the mobile
   app.
6. Open your database's SQL editor and run
   `scripts/add-google-auth-column.sql` exactly once.
7. Restart both the backend and Expo app. For Android/iOS, make a new dev or
   production build after changing native OAuth credentials; Expo Go is not a
   reliable target for this configuration.

Google ID tokens are verified on the backend. Existing email/password users
with the same verified Google email are linked to that Google account; new
users are created directly without the email OTP step.
