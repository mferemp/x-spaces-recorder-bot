/**
 * Capacitor config for wrapping X Space Recorder as a native iOS / Android app.
 *
 * This file is used ONLY when you package the app for the App Store / Play Store
 * on your own machine (see STORE.md). It has no effect on the live web app.
 *
 * IMPORTANT: set `server.url` to your deployed HTTPS URL before building, so the
 * native shell loads your always-on backend (recording needs the server running).
 */
const config = {
  appId: 'app.spacerecorder.local',
  appName: 'X Space Recorder',
  webDir: 'frontend/dist',
  backgroundColor: '#0b0b0f',
  server: {
    // Point this at your published site so the app talks to your live backend.
    // Example: 'https://recorder.example.com'
    url: 'https://REPLACE_WITH_YOUR_DEPLOYED_URL',
    cleartext: false,
  },
  ios: {
    contentInset: 'always',
    backgroundColor: '#0b0b0f',
  },
  android: {
    backgroundColor: '#0b0b0f',
  },
}

module.exports = config
