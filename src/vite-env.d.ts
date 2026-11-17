/// <reference types="vite/client" />

// WA-verify-5 #67: app version injected from package.json by vite.config.ts.
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_AWS_REGION?: string;
  readonly VITE_AWS_USER_POOL_ID?: string;
  readonly VITE_AWS_USER_POOL_CLIENT_ID?: string;
  readonly VITE_AWS_IDENTITY_POOL_ID?: string;
  readonly VITE_AWS_S3_BUCKET?: string;
  readonly VITE_AWS_APPSYNC_ENDPOINT?: string;
  readonly VITE_AWS_APPSYNC_API_KEY?: string;
  readonly GEMINI_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
