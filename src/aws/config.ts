import { Amplify } from 'aws-amplify';

export interface AwsConfig {
  region: string;
  userPoolId: string;
  userPoolClientId: string;
  identityPoolId?: string;
  s3Bucket: string;
  appSyncGraphQLEndpoint?: string;
  appSyncApiKey?: string;
}

const getEnvVal = (key: string, fallback: string = ''): string => {
  if (typeof import.meta !== 'undefined' && (import.meta as any)?.env) {
    return (import.meta as any).env[key] || fallback;
  }
  if (typeof process !== 'undefined' && process.env) {
    return (process.env as any)[key] || fallback;
  }
  return fallback;
};

export const getAwsEnvConfig = (): AwsConfig => {
  return {
    region: getEnvVal('VITE_AWS_REGION', 'ap-south-1'),
    userPoolId: getEnvVal('VITE_AWS_USER_POOL_ID', ''),
    userPoolClientId: getEnvVal('VITE_AWS_USER_POOL_CLIENT_ID', ''),
    identityPoolId: getEnvVal('VITE_AWS_IDENTITY_POOL_ID', ''),
    s3Bucket: getEnvVal('VITE_AWS_S3_BUCKET', ''),
    appSyncGraphQLEndpoint: getEnvVal('VITE_AWS_APPSYNC_ENDPOINT', ''),
    appSyncApiKey: getEnvVal('VITE_AWS_APPSYNC_API_KEY', ''),
  };
};

export const isAwsConfigured = (): boolean => {
  const cfg = getAwsEnvConfig();
  // Report 3 #230 (W5b): the AppSync endpoint gates `configured` too.
  // Pool-only configs used to pass this check while every data write
  // failed (Cognito login succeeds, AppSync has nowhere to go). A
  // partial config must behave as local mode, loudly, not as a
  // half-real build. Behaviour on a fully-configured build is unchanged.
  return Boolean(
    cfg.userPoolId &&
    cfg.userPoolClientId &&
    cfg.appSyncGraphQLEndpoint &&
    cfg.appSyncGraphQLEndpoint.startsWith('https://'),
  );
};

/**
 * Report 3 #229/#230 (W5b): diagnostics for the App-shell banners.
 * `configured` is the `isAwsConfigured()` verdict; `partial` is true
 * when some (but not all) of pool / client / endpoint are present;
 * `missing` names the empty fields among userPoolId /
 * userPoolClientId / appSyncGraphQLEndpoint (+ `s3Bucket`, reported for
 * diagnostics only — a missing bucket never alone triggers the partial
 * banner, media upload already fails loudly on its own path, D7).
 * Region defaults to 'ap-south-1' in `getAwsEnvConfig`, so a defaulted
 * region is never reported missing.
 */
export function getAwsConfigStatus(): { configured: boolean; partial: boolean; missing: string[] } {
  const cfg = getAwsEnvConfig();
  const missing: string[] = [];
  if (!cfg.userPoolId) missing.push('userPoolId');
  if (!cfg.userPoolClientId) missing.push('userPoolClientId');
  if (!cfg.appSyncGraphQLEndpoint || !cfg.appSyncGraphQLEndpoint.startsWith('https://')) missing.push('appSyncGraphQLEndpoint');
  if (!cfg.s3Bucket) missing.push('s3Bucket');
  const configured = isAwsConfigured();
  // Partial = at least one of the gating fields is present but the build
  // is not fully configured. A missing bucket alone is not partial.
  const gatingMissing = missing.filter((m) => m !== 's3Bucket');
  const gatingPresent = 3 - gatingMissing.length;
  return { configured, partial: !configured && gatingPresent > 0, missing };
}

export const initAwsAmplify = () => {
  const cfg = getAwsEnvConfig();

  if (!isAwsConfigured()) {
    console.info(
      'ℹ️ AWS credentials not yet populated in .env. Pinglo is running in hybrid local mode. See AWS_SETUP_GUIDE.md to connect your AWS Cognito & S3 bucket.'
    );
    return;
  }

  try {
    Amplify.configure({
      API: {
        GraphQL: {
          endpoint: cfg.appSyncGraphQLEndpoint || '',
          region: cfg.region,
          defaultAuthMode: 'userPool',
        },
      },
      Auth: {
        Cognito: {
          userPoolId: cfg.userPoolId,
          userPoolClientId: cfg.userPoolClientId,
          identityPoolId: cfg.identityPoolId || undefined,
          loginWith: {
            email: true,
          },
        },
      },
      Storage: {
        S3: {
          bucket: cfg.s3Bucket,
          region: cfg.region,
        },
      },
    });
    console.log('✅ AWS Amplify initialized successfully with AWS Cognito & S3!');
  } catch (err) {
    console.warn('⚠️ AWS Amplify configuration warning:', err);
  }
};
