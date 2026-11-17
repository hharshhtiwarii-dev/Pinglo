> **Renamed DT Chats → Pinglo; the app, package and repo are now Pinglo.**

# Pinglo – fixes (backend + app)

## Backend (AWS YOUR_REGION, stack `YOUR_BACKEND_STACK`)
- Cognito Identity Pool linked to the user pool. Authenticated role can only read/write `avatars/*` and `media/*` (profile photos, media).
- S3 bucket `YOUR_BUCKET_NAME`: all 4 public-access blocks on.
- DynamoDB table `dtchats-docs` (PK `col`, SK `id`).
- AppSync GraphQL API (Cognito auth): `getDoc`, `listDocs`, `putDoc`, `deleteDoc`, `turnCredentials`, and realtime `onDocChanged`.
- Ownership rules (enforced in AppSync):
  - `users/{id}` can only be written by that user.
  - `users/{id}/...` subcollections (PIN, vault, starred) can only be read or written by their owner.
  - Subscriptions follow the same read rule.
- TURN relay: coturn (Docker) on EC2 t3.micro with Elastic IP `YOUR_TURN_SERVER`. The `turnCredentials` query issues short-lived (12h) credentials from a Lambda. The shared secret never reaches the app.

## App
- `src/aws/database.ts`: data layer uses AppSync/DynamoDB instead of localStorage. Same Firestore-style API, so screens are unchanged. Data is shared and updates arrive in realtime.
- `src/services/realtimeSync.ts`: public MQTT broker removed. Messages, reactions and deletes go through the shared store. Typing status uses a `typing` collection.
- `src/services/callService.ts`:
  - Calls to offline users end with a message, not a stuck overlay.
  - 45s ring timeout.
  - Busy check fixed (it used a status that never existed).
  - PeerJS auto-reconnects.
  - TURN credentials added to the peer config. Init is shared, so startCall waits for a ready peer.
- `src/services/turn.ts`: fetches TURN credentials (falls back to STUN if unavailable).
- `src/services/adminService.ts`: loads collections before reading them. Fixed a type error.
- `src/App.tsx`: local cache is cleared when the signed-in account changes.
- `src/aws/config.ts`: AppSync endpoint added to the Amplify config.
- `.env`: identity pool and AppSync endpoint set. Gemini keys were NOT changed.
- `package.json`: `mqtt` kept so `package-lock.json` stays in sync. It is no longer imported.

## Still to verify on a device
- `npm install && npm run build`.
- Two accounts: messages, reactions, deletes, typing, profile edits, admin page.
- A call between two devices, including one behind mobile data, to confirm TURN relays.

## Round 3 fixes
- Call screen / modals going off-screen: the `animate-fade-in` keyframe used `translateX(-50%)` with `forwards`, which pushed full-screen overlays half outside the phone. That was also why the call covered admin and profile. The keyframe no longer shifts horizontally. Only centred toasts use the new `animate-toast` class.
- Call overlay width is now `w-full` (was `w-screen`).
- AppSync field logging set to ERROR (CloudWatch log group `/aws/appsync/apis/YOUR_APPSYNC_API_ID`) so real-time/resolver failures can be read.
- Rebuild the APK after changes (`npm run build && npx cap sync android`). Values in `.env` are baked in at build time.
