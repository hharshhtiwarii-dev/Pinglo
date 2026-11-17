# 🚀 Pinglo — AWS Complete Setup Guide (Beginner Friendly)

> **Namaste!** Agar aapne AWS Console abhi pehli baar open kiya hai aur pehle kabhi AWS use nahi kiya, toh tension mat lijiye. Ye guide step-by-step follow karke aap 10-15 minute mein apne Pinglo ko poora AWS se connect kar lenge!
> 
> Sabhi services **AWS Free Tier** mein aati hain, isliye shuruat mein koi extra bill nahi aayega.

---

## 📌 Pinglo mein AWS ka Role:
| Pehle Kya Tha | Ab AWS Mein Kya Hai | Kaam Kya Hai |
| :--- | :--- | :--- |
| **Firebase Auth** | **AWS Cognito User Pool** | User Login, Signup, Password Reset, Profile Data |
| **Cloudinary / Firebase Storage** | **AWS S3 Bucket** | Images, Profile Photos, Videos, Voice Notes, Documents |
| **Firebase Firestore** | **AWS Real-Time Data Layer (DynamoDB / AppSync / Local Sync)** | Chat messages, community rooms, status updates, stars |

---

## 🟢 Step 1: AWS Region Choose Karein
1. Apne browser mein [https://console.aws.amazon.com](https://console.aws.amazon.com) kholein aur login karein.
2. Top right corner mein aapko region dropdown dikhega (jaise `Global` ya `us-east-1`).
3. Dropdown par click karein aur **Asia Pacific (Mumbai) `ap-south-1`** select karein (ya jo region aapke sabse paas ho).
4. Apne project ke `.env` file mein `VITE_AWS_REGION=ap-south-1` rakhein.

---

## 🟢 Step 2: AWS Cognito User Pool Banayein (Auth ke liye)

Cognito aapke users ka Email, Password aur Profile securely handle karega.

1. AWS Console ke search bar mein **"Cognito"** type karein aur **Amazon Cognito** open karein.
2. **"Create user pool"** button par click karein.
3. **Step 1: Configure sign-in experience**
   - **Cognito user pool sign-in options**: Check karein **"Email"**.
   - Next par click karein.
4. **Step 2: Configure security requirements**
   - Password policy: **"Cognito defaults"** rehne dein.
   - Multi-factor authentication (MFA): Agar shuruat mein simple rakhna hai to **"No MFA"** select karein.
   - User account recovery: Check karein **"Enable self-service account recovery"** -> **"Email only"**.
   - Next par click karein.
5. **Step 3: Configure sign-up experience**
   - Self-service sign-up: Check karein **"Enable self-registration"**.
   - Attribute verification: **"Send email message, verify email address"**.
   - Required attributes: `name` select kar sakte hain (optional).
   - Next par click karein.
6. **Step 4: Configure message delivery**
   - Email provider: **"Send email with Cognito"** select karein (ye free tier ke andar bina SES domain verify kiye testing ke liye best hai).
   - Next par click karein.
7. **Step 5: Integrate your app**
   - **User pool name**: Daalein `pinglo-users`.
   - **Initial app client**:
     - App type: **"Public client"** select karein.
     - App client name: `pinglo-web-client`.
     - Client secret: **"Don't generate a client secret"** (ZAROORI: Web/React apps mein client secret nahi hona chahiye).
   - Next par click karein.
8. **Step 6: Review and create**
   - Sabhi settings review karein aur **"Create user pool"** par click karein!

### 📋 Values Copy Karein:
Pool banne ke baad pool par click karein:
- **User Pool ID**: Jaise `ap-south-1_xxxxxxxxx` dikhega. Ise copy karke `.env` mein `VITE_AWS_USER_POOL_ID` mein daalein.
- **App integration** tab par click karein -> Neeche scroll karein -> **App clients and analytics** section mein **Client ID** copy karein (e.g. `1a2b3c4d5e...`). Ise `.env` mein `VITE_AWS_USER_POOL_CLIENT_ID` mein daalein.

---

## 🟢 Step 3: AWS S3 Bucket Banayein (Media & Photos ke liye)

1. AWS Console search bar mein **"S3"** search karein aur open karein.
2. **"Create bucket"** button par click karein.
3. **Bucket name**: Koi unique naam dein, e.g., `pinglo-media-YOUR-NAME-1234`.
4. **AWS Region**: Wahi choose karein jo Cognito mein chuna tha (`ap-south-1`).
5. **Object Ownership**: **"ACLs disabled (recommended)"** rehne dein.
6. **Block Public Access settings for this bucket**:
   - Agar chat photos/avatars direct display karni hain: Uncheck **"Block all public access"** karein aur warning checkbox acknowledge karein.
7. **"Create bucket"** par click karein.

### 🌐 CORS Setup Karein (Taaki browser se direct photo upload ho sake):
1. Apne naye banaye bucket par click karein.
2. **Permissions** tab par click karein.
3. Neeche scroll karke **Cross-origin resource sharing (CORS)** section par jayein aur **Edit** click karein.
4. Ye JSON paste karein aur **Save changes** click karein:
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

### 📋 Values Copy Karein:
- Bucket ka naam copy karein aur apne `.env` file mein `VITE_AWS_S3_BUCKET` mein daalein.

---

## 🟢 Step 4: `.env` File Mein Credentials Daalein

Apne Pinglo project ke root folder mein `.env` file kholein aur values paste karein:

```env
# AWS Region
VITE_AWS_REGION=ap-south-1

# AWS Cognito (Auth)
VITE_AWS_USER_POOL_ID=ap-south-1_xxxxxxxxx
VITE_AWS_USER_POOL_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx

# AWS S3 (Media Storage)
VITE_AWS_S3_BUCKET=pinglo-media-YOUR-NAME-1234

# Google Gemini AI Key (AI Chat bot ke liye - optional)
GEMINI_API_KEY=
```

File ko **Save** karein (`Ctrl + S`).

---

## 🟢 Step 5: App Run Karein!

Terminal mein commands chalayein:

```bash
# Dependencies check (already installed)
npm run lint

# Start Pinglo dev server
npm run dev
```

Browser mein `http://localhost:3000` kholein:
- Naya account sign up karein (Cognito User Pool mein user register hoga!).
- Profile photo ya chat image bhej kar dekhein (S3 Bucket mein upload hogi!).

---

## 💡 Zero-Crash Hybrid Architecture:
Agar aapne abhi AWS setup poora nahi kiya ya `.env` abhi blank hai:
- Pinglo **bilkul crash nahi hoga**.
- Isme **Zero-Crash Hybrid Fallback** built-in hai: Ye local simulated auth aur in-memory/broadcast channel real-time sync use karega taaki aap UI, testing aur development bina kisi rukawat ke continue kar sakein.
- Jaise hi aap `.env` mein AWS credentials bharte hain, ye transparently real AWS services par switch ho jata hai!
