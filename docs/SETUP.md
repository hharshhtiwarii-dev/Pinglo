# Pinglo — AWS Setup Guide

A step-by-step guide to connect Pinglo to your own AWS account. Written for beginners. Short sentences. No step skipped.

> **Before you start:** create an AWS account at <https://aws.amazon.com> and sign in to the AWS Console at <https://console.aws.amazon.com>. Most of these services have a free tier, but watch your usage — free tier limits are per month, and extra use costs money.

> **Placeholders:** every value in this guide like `YOUR_USER_POOL_ID` is a placeholder. Replace it with your own real value. Never share your real IDs or keys in public.

## What you will create

| # | AWS service | What it does in Pinglo | `.env` key |
| --- | --- | --- | --- |
| 1 | Cognito User Pool | Sign up, log in, password reset | `VITE_AWS_USER_POOL_ID`, `VITE_AWS_USER_POOL_CLIENT_ID` |
| 2 | Cognito Identity Pool | Lets the app reach S3 directly (optional) | `VITE_AWS_IDENTITY_POOL_ID` |
| 3 | S3 bucket | Stores photos, videos, voice notes, documents | `VITE_AWS_S3_BUCKET` |
| 4 | AppSync API | Stores chat data and sends live updates | `VITE_AWS_APPSYNC_ENDPOINT`, `VITE_AWS_APPSYNC_API_KEY` |
| 5 | DynamoDB table | The database behind AppSync | (no `.env` key — AppSync connects to it) |
| 6 | TURN server (EC2) | Helps voice and video calls connect | (no `.env` key — served through AppSync, see Step 6) |

## Step 0: Pick a region

1. Open the AWS Console.
2. Top-right corner: click the region dropdown.
3. Pick the region closest to your users, for example `ap-southeast-2` (Sydney) or `ap-south-1` (Mumbai).
4. Use this **same region for every service below**.
5. In your `.env` file, set:
   ```env
   VITE_AWS_REGION=YOUR_AWS_REGION
   ```

## Step 1: Cognito User Pool (login and sign up)

Cognito stores your users' email, password, and profile.

1. In the Console search bar, type **Cognito** and open **Amazon Cognito**.
2. Click **Create user pool**.
3. **Sign-in options:** tick **Email**. Click Next.
4. **Security requirements:**
   - Password policy: leave **Cognito defaults**.
   - Multi-factor authentication (MFA): pick **No MFA** to start simple.
   - Account recovery: tick **Enable self-service account recovery** > **Email only**.
   - Click Next.
5. **Sign-up experience:**
   - Tick **Enable self-registration**.
   - Email verification: **Send email message, verify email address**.
   - Required attributes: `name` is optional.
   - Click Next.
6. **Message delivery:** pick **Send email with Cognito**. Click Next.
7. **Integrate your app:**
   - User pool name: `pinglo-users` (or your own name).
   - App type: **Public client**.
   - App client name: `pinglo-web-client`.
   - Client secret: **Don't generate a client secret**. This is important — web apps must not have a client secret.
   - Click Next.
8. Review and click **Create user pool**.

### Copy these values into `.env`

- Open your new pool. Copy the **User Pool ID** (it looks like `YOUR_REGION_xxxxxxxxx`):
  ```env
  VITE_AWS_USER_POOL_ID=YOUR_USER_POOL_ID
  ```
- Go to the **App integration** tab, scroll to **App clients and analytics**, and copy the **Client ID**:
  ```env
  VITE_AWS_USER_POOL_CLIENT_ID=YOUR_USER_POOL_CLIENT_ID
  ```

## Step 2: Cognito Identity Pool (optional)

This pool gives signed-in users direct access to your S3 bucket. Skip this step if you do not need direct S3 access — the app still works without it.

1. In the Console, open **Cognito** > **Identity Pools** (or **Federated Identities**).
2. Click **Create identity pool**.
3. Name it `pinglo-identity-pool`.
4. Tick **Enable access to unauthenticated identities** only if you want guests to reach S3 without logging in. For a chat app, leave it off.
5. Under **Authentication providers**, add your User Pool from Step 1 (paste its User Pool ID and App Client ID).
6. Create the pool. AWS creates two IAM roles (one for logged-in users, one for guests).
7. Copy the **Identity Pool ID** (it looks like `YOUR_REGION:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`):
   ```env
   VITE_AWS_IDENTITY_POOL_ID=YOUR_IDENTITY_POOL_ID
   ```

## Step 3: S3 bucket (photos, videos, voice notes, files)

1. In the Console search bar, type **S3** and open it.
2. Click **Create bucket**.
3. **Bucket name:** pick a name that is unique in all of AWS, for example `pinglo-media-YOUR-NAME-1234`.
4. **Region:** pick the same region as Step 0.
5. **Object Ownership:** leave **ACLs disabled (recommended)**.
6. **Block Public Access:** keep **Block all public access** turned ON. The app uploads through signed access, so public access is not needed.
7. Click **Create bucket**.

### Allow the browser to upload (CORS)

Without this, the browser blocks photo uploads.

1. Open your new bucket.
2. Go to the **Permissions** tab.
3. Scroll to **Cross-origin resource sharing (CORS)** and click **Edit**.
4. Paste this and click **Save changes**:
   ```json
   [
     {
       "AllowedHeaders": ["*"],
       "AllowedMethods": ["GET", "PUT", "POST", "HEAD"],
       "AllowedOrigins": ["*"],
       "ExposeHeaders": ["ETag"]
     }
   ]
   ```
   For a real public app, replace `"*"` in `AllowedOrigins` with your own app domain.

### Copy this value into `.env`

```env
VITE_AWS_S3_BUCKET=YOUR_S3_BUCKET_NAME
```

## Step 4: AppSync API (chat data and live updates)

AppSync is the GraphQL API that stores chats, messages, status posts, and more, and pushes live updates to every device.

1. In the Console search bar, type **AppSync** and open **AWS AppSync**.
2. Click **Create API**, then pick **Build from scratch** (GraphQL).
3. Name it `pinglo-api`.
4. **Authorization:** pick **API key** to start. (For a real public app, switch to Cognito User Pools auth later — an API key alone is not safe for real users.)
5. Create the API.

### Copy these values into `.env`

- On the API page, go to **Settings** and copy the **GraphQL endpoint** (an `https://` URL):
  ```env
  VITE_AWS_APPSYNC_ENDPOINT=YOUR_APPSYNC_ENDPOINT_URL
  ```
- On the same page, copy the **API key**:
  ```env
  VITE_AWS_APPSYNC_API_KEY=YOUR_APPSYNC_API_KEY
  ```

### Schema and resolvers — read this before you go further

The GraphQL schema (types, queries, mutations, subscriptions) and the resolvers that connect AppSync to DynamoDB are **not in this repo**. They live only in the AppSync console. You must create them yourself in the console, or import them from your own backend project.

That means: after Step 4, the app will connect to AppSync, but chat sync will not work until a matching schema and resolvers exist. This is the one setup step we could not fully document from the code alone. If you already have a working AppSync API for Pinglo, reuse its endpoint and key.

## Step 5: DynamoDB table (the database behind AppSync)

AppSync does not store data by itself — it reads and writes a DynamoDB table.

1. In the Console search bar, type **DynamoDB** and open it.
2. Click **Create table**.
3. **Table name:** `pinglo-docs` (or your own name — just remember it).
4. **Partition key:** `id` (type: String).
5. Leave the other settings on their defaults. On-demand capacity is the simplest choice to start.
6. Click **Create table**.

Then, in AppSync, attach this table as a data source:

1. Open your AppSync API from Step 4.
2. Go to **Data Sources** > **Create data source**.
3. Pick **Amazon DynamoDB table** and select your table.
4. Create resolvers that map your GraphQL operations to this table (see the note in Step 4).

**Safety settings worth turning on** (DynamoDB console, table settings):

- **Deletion protection:** ON (stops the table being deleted by accident).
- **Point-in-time recovery (PITR):** ON (lets you restore data).

## Step 6: TURN server (voice and video calls)

Voice and video calls are peer-to-peer WebRTC. When two phones are on different networks, they often cannot connect directly. A TURN server relays the call media so the call still works.

Pinglo gets its TURN login details from AppSync: the app runs a `turnCredentials` GraphQL query, and a backend function (Lambda behind AppSync) returns a short-lived username, password, and server address. You need both parts:

### 6a. Run a coturn server

1. Launch a small EC2 instance (for example `t3.micro`) in your region.
2. Install coturn on it and open UDP ports **3478** and TCP/TLS port **5349** in the instance security group.
3. Note the server's public address (a domain name or an IP address).

### 6b. Serve the credentials through AppSync

Create a resolver (backed by a Lambda function) for the `turnCredentials` query. It should return the coturn username, password, and URLs. The exact Lambda code is not in this repo — it belongs to your backend, not the app.

> Without a TURN server, calls still work when both phones are on the same network, but often fail across different networks. There is no `.env` key for TURN — the app fetches it from AppSync at call time.

## Step 7: Put it all in `.env` and run

1. In the project root, copy the template:
   ```bash
   cp .env.example .env
   ```
2. Fill in every value you copied above. Your finished file should have:
   ```env
   VITE_AWS_REGION=YOUR_AWS_REGION
   VITE_AWS_USER_POOL_ID=YOUR_USER_POOL_ID
   VITE_AWS_USER_POOL_CLIENT_ID=YOUR_USER_POOL_CLIENT_ID
   VITE_AWS_IDENTITY_POOL_ID=YOUR_IDENTITY_POOL_ID
   VITE_AWS_S3_BUCKET=YOUR_S3_BUCKET_NAME
   VITE_AWS_APPSYNC_ENDPOINT=YOUR_APPSYNC_ENDPOINT_URL
   VITE_AWS_APPSYNC_API_KEY=YOUR_APPSYNC_API_KEY
   ```
3. Start the app:
   ```bash
   npm install
   npm run dev
   ```
4. Open <http://localhost:3000>, sign up a new account, and send a message or a photo to test it.

## Local mode (no AWS yet)

If `.env` is empty or missing, the app does **not** crash. It runs in local mode: it uses a local sign-in and keeps data on your device, so you can try the UI and test screens without AWS. As soon as you add real AWS values, it switches to the real services. Local mode is for trying things out — messages in local mode are not shared with other people.

## Optional: Dev AI (Gemini) and GIFs

These are not AWS services, but they need keys too:

- **Dev AI:** get a free Gemini key at <https://aistudio.google.com/apikey> and set `VITE_GEMINI_API_KEY` in `.env`. Leave it empty and Dev AI stays off.
- **GIFs:** get a free Giphy key at <https://developers.giphy.com> and set `VITE_GIPHY_API_KEY` in `.env`. Leave it empty and GIF search stays off.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| Sign up fails | Is the User Pool ID and Client ID correct? Did you pick a **public client with no client secret**? |
| Login works but chats never load | Is the AppSync endpoint an `https://` URL? Is the API key correct? Does the AppSync schema exist (Step 4 note)? |
| Photo upload fails | Is the S3 bucket name right? Is CORS set on the bucket (Step 3)? |
| Calls fail on different networks | Is your TURN server running and reachable? Does the `turnCredentials` query return values? |
| App works but nothing syncs | You may be in local mode — check that `.env` is filled in and restart `npm run dev` after changing `.env`. |

## Security notes

- **Never commit `.env` to git.** It holds private keys. Only `.env.example` (placeholders) belongs in the repo.
- **Rotate any key that was ever shared or posted in public.** Old keys stay valid until you revoke them.
- An AppSync **API key is not real security** for a public app. Use Cognito auth on AppSync before real users join.
- The Gemini API key ships inside the app bundle, so anyone can read it. Use a key with strict limits, and rotate it often.
