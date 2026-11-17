# 📱 Pinglo — Android APK Build Guide
## Android Studio se APK kaise banaye — Step by Step

---

## 🛠️ Prerequisites (Pehle yeh install karo)

| Tool | Download Link | Version |
|------|--------------|---------|
| **Node.js** | https://nodejs.org | v18+ |
| **Android Studio** | https://developer.android.com/studio | Latest |
| **Java JDK** | Android Studio ke saath aata hai | 17+ |

---

## ⚙️ STEP 1 — Android Studio Setup

1. Android Studio install karo
2. Pehli baar open karo → SDK Manager open hoga
3. Yeh install karo:
   - **Android SDK Platform 34** (Android 14)
   - **Android SDK Build-Tools 34**
   - **Android Emulator** (testing ke liye)
   - **Google USB Driver** (real device ke liye)
4. `ANDROID_HOME` environment variable set karo:
   - Windows: `C:\Users\YourName\AppData\Local\Android\Sdk`
   - Mac/Linux: `~/Library/Android/sdk`

---

## 📦 STEP 2 — Project Setup

### 2.1 — Project folder mein jaao aur dependencies install karo
```bash
cd pinglo          # apna folder name
npm install
```

### 2.2 — Firebase config setup karo
`src/firebase.ts` file kholke apni Firebase credentials daalo:
```typescript
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};
```

> Firebase Console → Project Settings → Your Apps → Web App → Config copy karo

### 2.3 — capacitor.config.ts mein App ID change karo
```typescript
appId: 'com.yourname.pinglo',  // apna unique ID daalo
appName: 'Pinglo',
```

---

## 🏗️ STEP 3 — Web App Build karo

```bash
npm run build
```

Yeh `dist/` folder create karega. Check karo ke `dist/index.html` bana hai.

---

## 📲 STEP 4 — Capacitor Android Project Add karo

### 4.1 — Android platform add karo (SIRF PEHLI BAAR)
```bash
npx cap add android
```

Yeh `android/` folder create karega — yahi Android Studio mein open karna hai.

### 4.2 — Web build ko Android mein sync karo
```bash
npx cap sync android
```

> ⚡ Har baar `npm run build` ke baad `npx cap sync android` run karo!

---

## 🖥️ STEP 5 — Android Studio mein Open karo

### Option A — Command se:
```bash
npx cap open android
```

### Option B — Manually:
1. Android Studio open karo
2. **File → Open**
3. Apne project ka `android/` folder select karo
4. **OK** click karo
5. Gradle sync hone do (1-2 minutes)

---

## 📱 STEP 6 — APK Build karo

### Debug APK (Testing ke liye — sabse aasan)
1. Android Studio mein: **Build → Build Bundle(s) / APK(s) → Build APK(s)**
2. Wait karo (2-5 min)
3. Notification aayegi "APK(s) generated"
4. **"locate"** click karo
5. APK milega: `android/app/build/outputs/apk/debug/app-debug.apk`

### Release APK (Production / Play Store ke liye)
1. **Build → Generate Signed Bundle / APK**
2. **APK** select karo → Next
3. **Create new keystore** (pehli baar):
   - Key store path: koi safe jagah save karo (`.jks` file)
   - Password: strong password daalo (yaad rakhna!)
   - Key alias: `pinglo-key`
   - Fill baaki details
4. Next → **Release** select karo
5. **Finish** → APK ban jayega
6. Location: `android/app/build/outputs/apk/release/app-release.apk`

> ⚠️ Keystore file aur password **kabhi mat bhoolna** — Play Store update ke liye same keystore chahiye!

---

## 📲 STEP 7 — Phone pe Install karo

### Real Android Phone pe:
1. Phone mein: **Settings → Developer Options → USB Debugging ON** karo
2. USB se connect karo
3. Android Studio mein upar device select karo
4. **▶️ Run** button press karo

### Sirf APK send karke install:
1. `app-debug.apk` WhatsApp/Google Drive se phone pe bhejo
2. Phone mein: **Settings → Install unknown apps → Allow**
3. APK tap karo → Install

---

## 🔧 Common Errors aur Solutions

### ❌ "SDK not found"
```
Fix: Android Studio → SDK Manager → SDK location copy karo
     System environment variable ANDROID_HOME set karo
```

### ❌ "Gradle sync failed"
```
Fix: File → Invalidate Caches → Invalidate and Restart
     Ya: android/ folder mein: ./gradlew clean
```

### ❌ "JAVA_HOME not set"
```
Fix: Android Studio → Settings → Build → Gradle → Gradle JDK
     JDK 17 select karo (Android Studio bundled)
```

### ❌ App crashes on open
```
Fix: Logcat check karo (Android Studio bottom panel)
     Firebase config sahi hai? firebase.ts check karo
```

### ❌ "capacitor not found"
```
Fix: npm install
     npx cap --version check karo
```

### ❌ White screen on app open
```
Fix: vite.config.ts mein base: './' set hai? Check karo
     npm run build phir npx cap sync android
```

### ❌ Keyboard ke upar content nahi aata
```
Fix: capacitor.config.ts mein Keyboard plugin settings check karo
     android/app/src/main/AndroidManifest.xml mein:
     android:windowSoftInputMode="adjustResize"
```

---

## 🔄 Daily Workflow (Changes ke baad)

```bash
# Code change kiya → Build → Sync → Android Studio auto-refresh
npm run build
npx cap sync android

# Ya ek command mein (package.json mein add kiya hai):
npm run android
```

---

## 📋 App Info for Play Store

Jab Play Store pe upload karna ho:

| Field | Value |
|-------|-------|
| App Name | Pinglo |
| Package Name | com.devbhai.pinglo |
| Min SDK | API 22 (Android 5.1) |
| Target SDK | API 34 (Android 14) |
| Version | 1.0.0 |

---

## 🎯 Quick Command Reference

```bash
npm install              # Dependencies install
npm run build            # Web app build (dist/ folder)
npx cap add android      # Android project add (sirf ek baar)
npx cap sync android     # Web build → Android sync
npx cap open android     # Android Studio mein open
npm run android          # Build + Sync + Open (sab ek saath)
```

---

## 💡 Pro Tips

1. **Debug build** pehle banao test ke liye — fast aur easy
2. **Release build** sirf Play Store ke liye banao
3. `android/` folder **git mein push karo** — doosre devices pe kaam aayega
4. Phone pe test karna emulator se better hai — real behavior milta hai
5. Firebase Console mein **SHA-1 fingerprint** add karna mat bhoolna:
   ```bash
   # Windows
   keytool -list -v -keystore "%USERPROFILE%\.android\debug.keystore" -alias androiddebugkey -storepass android -keypass android
   
   # Mac/Linux
   keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android -keypass android
   ```
   Firebase Console → Project Settings → Your Apps → Add fingerprint

---

Koi problem ho toh Dev Bhai se contact karo 😎
