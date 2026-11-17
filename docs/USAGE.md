# Pinglo — How to Use

A short guide to every feature in the app. One section per feature.

## Sign up and log in

1. Open the app. On the welcome screen, tap **Sign up**.
2. Enter your name, email, and a password. Tap **Sign up**.
3. Check your email for a confirmation code (OTP). Enter the code in the app to confirm your account.
4. Log in with your email and password.
5. Forgot your password? Tap **Forgot password** on the login screen, enter your email, and set a new password with the code sent to you.

If you are in local mode (no AWS set up), sign-up works on your device only and does not create a real account.

## Start a chat

1. On the Chats tab, tap the **new chat** button.
2. Pick a contact from the list, or search by name.
3. Type a message and tap **Send** (or press Enter).

To start a **group chat**, pick **New group**, add people, give the group a name, and tap **Create**.

## Send messages, photos, and files

- **Text:** type and tap Send.
- **Photo or video:** tap the **+** / attach button, then pick Camera or Gallery.
- **Document:** tap attach, then pick a file.
- **Voice note:** press and hold the microphone button, speak, and release to send. Slide your finger up to lock recording (hands-free). Slide left to cancel.
- **Emoji:** tap the emoji button next to the message box.
- **Stickers:** tap the sticker button in the emoji panel.
- **GIFs:** tap the GIF button in the emoji panel and search. (GIF search needs a Giphy key — see `docs/SETUP.md`. Without it, the GIF button does nothing.)

## React, reply, edit, delete, and more

- **React:** tap or long-press a message, then pick an emoji.
- **Reply:** swipe right on a message, or long-press it and tap Reply.
- **Edit:** long-press your own message and tap Edit.
- **Delete:** long-press a message and tap Delete. You can delete for yourself or for everyone.
- **Pin:** long-press a message and tap Pin to keep it at the top of the chat.
- **Star:** long-press a message and tap Star. Find starred messages later in **Settings > Starred messages**.
- **Save:** long-press a message and tap Save to keep it in **Saved Messages**.
- **Poll:** in a chat, tap attach and pick **Poll**. Add up to 6 options and send. Everyone can vote and see live results.
- **View Once:** when sending a photo or video, tap the **1** icon before sending. The media disappears after the other person views it once.
- **Schedule a message:** long-press the send area or open **Scheduled messages** from the menu, write your message, pick a date and time, and save it. The app sends it at that time.
- **Search in a chat:** open a chat, tap the menu, then **Search**. Type to find old messages.

## Make a voice or video call

1. Open a chat and tap the **phone** icon (voice) or the **video camera** icon (video call).
2. Or go to the **Calls** tab and tap the call button next to a contact.
3. During a call you can mute yourself, turn your camera off, switch to speaker, or end the call with the on-screen buttons.
4. Missed, incoming, and outgoing calls appear in the **Calls** tab.

Call links: from the **Calls** tab you can create a call link and share it. Anyone with the link can join the call.

> Calls are peer-to-peer. They work best when both people have a good connection. If calls fail across different networks, a TURN server is needed (see `docs/SETUP.md`, Step 6).

## Post a status

1. Go to the **Status** tab.
2. Tap **My status** or the **+** button.
3. Pick a photo or video, or write a text status.
4. Before posting, pick who can see it: **Everyone**, **Contacts**, **Close friends**, or **Only me**.
5. Tap **Send**. Your status disappears after 24 hours.
6. To view someone's status, tap their name in the Status tab. Tap the right side to go forward, the left side to go back.

## Lock a chat

1. Open a chat, tap the menu, and pick **Lock chat**.
2. Set a secret code (at least 4 characters) the first time.
3. The chat disappears from the chat list. It is hidden from search, notifications, and the gallery too.
4. To open a locked chat, type your **secret code in the search bar** on the Chats tab. The locked chats folder appears.
5. Unlock the chat with your PIN or fingerprint.

To change the secret code or remove a lock, open the locked chats folder and use the options there.

## Lock the whole app

1. Go to **Settings > App lock**.
2. Turn on **App lock** and set a PIN.
3. Turn on fingerprint unlock if your phone supports it.
4. The app locks itself when you leave it (you can pick the lock delay). Enter your PIN or fingerprint to open it again.

## Use the secret vault

1. Find the vault in Settings (or the 3-tap gesture on the app's main screen, if enabled).
2. Set a separate PIN for the vault the first time.
3. Store private items there. The vault has its own PIN — it is not the same as the app lock PIN.

## Change the theme

1. Go to **Settings > Theme** (or **Chats > Theme**).
2. Pick one of the **15 preset themes**, or pick **Custom** and choose your own colours.
3. Pick a **chat wallpaper** and move the brightness slider until it looks right.
4. Pick the **app theme**: Light, Dark, or System (follow your phone).
5. To change the theme of one chat only, open that chat, tap the menu, and pick **Theme** or **Wallpaper**.

## Use Saved Messages

- **Saved Messages** sits at the top of your chat list. It is your private space.
- To save something, long-press any message and tap **Save**.
- Open Saved Messages any time to read what you saved. It keeps every message type: text, photos, voice notes, and more.

## Use Dev AI (the AI assistant)

1. Open **Dev AI** from the main screen or the menu.
2. Ask a question in Hinglish or English. Dev AI answers in a friendly way.
3. You can also ask it to make a picture from a text description.
4. Dev AI needs a free Gemini API key to work (see `docs/SETUP.md`). Without a key, Dev AI stays off and the app still works fine.

## Broadcasts, communities, and groups

- **Broadcast list:** open the menu and pick **New broadcast**. Add people, then send one message — each person gets it as a private message.
- **Community:** go to the **Communities** tab, tap **Create**, and add channels inside it.
- **Group invite link:** open a group, tap the group name, then **Invite via link**. Share the link and anyone with it can join.

## Back up and restore chats

1. Go to **Settings > Chats > Chat backup**.
2. Tap **Back up** to save your chats on your device.
3. To restore, use **Restore** on the same screen.

Backups are stored on your device. They are not uploaded to the cloud.

## Block a contact

1. Open the chat, tap the name at the top, and pick **Block**.
2. Blocked contacts cannot message or call you.
3. To unblock, go to **Settings > Blocked contacts** and tap **Unblock**.

## Change your profile

1. Go to **Settings** and tap your name or photo at the top.
2. Change your display name, About text, or profile photo.
3. Your profile photo is uploaded to S3 (when AWS is set up).
